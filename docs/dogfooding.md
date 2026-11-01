# Dùng Cuesura để phát triển Cuesura

Quy trình này dùng bản `cusr` đã đóng băng để phát triển bản kế tiếp. Vướng mắc gặp khi dùng được ghi
thành việc, sửa qua chính `cusr`, rồi có hiệu lực ở release sau.

## Ranh giới

- **Agent không merge.** Người dùng xác nhận run config, duyệt và merge mọi PR; vòng cải thiện không có
  đường tắt nào bỏ qua bước này.
- **Gate lấy từ commit base.** PR sửa `cusr.yaml` hay CI không tự nới gate cho chính nó.
- **Worker không dùng `cusr`.** Skill và token chỉ dành cho assistant caller điều phối; không truyền vào worker.
- **Một release, một task.** V1 chạy một task tại một thời điểm.

## Bố cục

Repo phát triển giữ nguyên ở `~/projects/metronome`. Phần vận hành nằm riêng ở `~/cuesura-dogfood/`:

| Đường dẫn | Vai trò |
| --- | --- |
| `releases/<sha>/` | Bản build đóng băng; không sửa tay |
| `current` | Symlink tới release đang dùng; `~/.local/bin/cusr*` chạy qua đây |
| `repo/` | Clone riêng của daemon; không làm việc trực tiếp ở đây |
| `data/` | Data dir của daemon, gồm `owner.token`; assistant không đọc file này |
| `access/assistant.token` | Token `read/operate`, chỉ cho project `cuesura` |
| `config.yaml`, `prompts/` | User config và prompt role |
| `tools/node/bin/` | Node và pnpm của vận hành; lệnh dùng PATH host và quyền native của harness |

Không chạy daemon từ repo phát triển: checkout hay build ở đó sẽ đổi code của CLI đang chạy, và worktree của
daemon sẽ lẫn vào `git worktree list`.

Skill `cusr` nằm ở `~/.claude/skills/cusr` và `~/.codex/skills/cusr`, không commit vào `.claude/skills` hay
`.agents/skills` của repo này: repo này cũng là repo đích, mà worker đọc được mọi file đã commit.

Kết nối cho assistant, lặp lại ở mỗi lệnh theo skill:

```sh
DATA_DIR=~/cuesura-dogfood/data
TOKEN_FILE=~/cuesura-dogfood/access/assistant.token
PROJECT=cuesura
BASE=main
PROFILE=dogfood
```

Cùng UID nên token map không phải ranh giới quyền thật ([deploy](../deploy/README.md#token-và-quyền)): việc
assistant không đọc `owner.token` là quy tắc, không phải giới hạn kỹ thuật.

## Cài đặt lần đầu (người dùng)

1. Chứng minh harness. Bước này gọi model thật và tốn usage:

   ```sh
   cd ~/cuesura-dogfood
   cusr-runner prove-harness --config config.yaml --data-dir data --harness claude \
     --model claude-opus-5-5 --effort medium \
     --max-invocations 9 --approval "<ai duyệt, ngày>" --out evidence-claude.json
   cusr-runner record-manifest --config config.yaml --data-dir data --harness claude \
     --evidence evidence-claude.json
   ```

   Lặp lại cho `--harness codex --model gpt-6.1-sol --effort high`. Manifest gắn với binary và pin, không gắn với
   model, nên các model còn lại trong bảng [Chọn model](#chọn-model) chạy được mà chưa có lượt chứng minh riêng.
   Coi task đầu tiên của mỗi model là lần kiểm thật của nó.

2. Bật daemon theo [mẫu service](../deploy/README.md#chạy-daemon-foreground-hoặc-service), với `ExecStart`
   trỏ tới `~/cuesura-dogfood/config.yaml` và `~/cuesura-dogfood/data`, thêm
   `Environment=PATH=%h/cuesura-dogfood/tools/node/bin:%h/.local/bin:/usr/bin:/bin`.

3. Kiểm tra `cusr doctor --project cuesura --json` trả `ok: true`.

## Vòng làm một việc

| Bước | Ai | Việc |
| --- | --- | --- |
| 1. Giao | Assistant | `cusr task add` với tiêu chí nghiệm thu quan sát được, kèm đề xuất run config và lý do |
| 2. Xác nhận | **Người dùng** | Đọc run config, chạy `cusr task confirm --run-config <digest>` |
| 3. Chạy | Daemon, worker | Worktree riêng, coder, gate, reviewer nếu `full-review`, tạo PR, chờ CI |
| 4. Theo dõi | Assistant | `task explain`, `task logs`, `inbox`; câu hỏi chưa rõ thì chuyển cho người dùng |
| 5. Merge | **Người dùng** | Đọc diff, merge trên GitHub; daemon ghi nhận DONE |
| 6. Cập nhật | Người dùng | Theo mục [Nâng và lùi release](#nâng-và-lùi-release) khi có thay đổi cần dùng |

### Chọn model

Assistant đề xuất theo bảng, nêu lý do ở `--reason`; người dùng là người chốt khi xác nhận. Không chắc thì chọn
mức cao hơn. Không đổi binding sau khi task đã chạy: muốn đổi thì tạo task mới.

| Mức | Khi nào | `--worker` | Mode |
| --- | --- | --- | --- |
| Mặc định | Code thường, logic có rẽ nhánh, sửa nhiều file, không chắc thuộc mức nào | `claude/opus/medium` | `full-review` |
| Nhẹ | Thay đổi nhỏ, phạm vi rõ, có test sẵn hoặc dễ thêm test; lỗi đã biết nguyên nhân | `codex/terra/medium` hoặc `claude/sonnet/medium` | `direct-pr`, thêm review nếu đụng logic trong `src/` |
| Lặt vặt | Việc gần như cơ học: đổi tên, sửa thông báo, định dạng, sửa fixture | `codex/luna/high` | `direct-pr` |

Reviewer của mọi `full-review` là `codex/sol/high`.

- **Vùng nhạy cảm luôn dùng mức mặc định:** `src/runner`, `src/daemon`, `src/adapters`, `cusr.yaml`, `.github`,
  `deploy` hoặc quyền, token, sandbox. Với vùng này, `full-review` là bắt buộc và người dùng chạy `pnpm test` trên host
  trước khi merge: gate chạy trên host, còn sandbox native của worker có thể làm một số test không chạy được. Báo rõ test bị skip; không dùng lời worker thay bằng chứng test host.
- **Giữa Terra và Sonnet:** hai model cùng mức. Có `full-review` thì ưu tiên Sonnet để reviewer Sol khác vendor;
  còn lại chọn bên còn hạn mức.
- **Nâng mức khi vướng:** task của mức nhẹ hoặc lặt vặt dừng vì hết budget hay sửa sai hai lần thì hủy, tạo task
  mới ở mức cao hơn với lý do ghi rõ. Đây là chọn lại model cho đúng việc, khác với tạo task để né budget.
- **Gemini 3.8 Flash (`gemini-3.8-flash-high`):** cân nhắc cho việc lặt vặt, nhưng **chưa chạy được qua `cusr`** vì
  harness hiện chỉ có Claude và Codex. Trước khi có adapter, dùng `agy` thủ công trong worktree riêng theo
  [AGENTS.md](../AGENTS.md), rồi tạo PR như thường.

Muốn thêm hoặc đổi model: sửa `models` và `binding` của `coder`, `fixer`, `reviewer` trong `config.yaml`, sửa bảng
trên, rồi restart daemon. `--worker` phải khớp đúng một binding đã khai, theo dạng `harness/tên-model/effort`.

Làm tay theo [AGENTS.md](../AGENTS.md) thay vì qua `cusr` khi:

- Daemon hoặc release đang hỏng: bản hỏng không tự sửa được chính nó.
- Việc cần thứ sandbox không có: smoke thật, kiểm host, credential.
- Việc chỉ sửa tài liệu mà không đáng tốn lượt agent.

Dùng đường này thì vẫn tạo PR như thường và ghi rõ lý do không dùng `cusr` trong mô tả PR.

## Vòng tự cải thiện

1. **Ghi lại ngay.** Khi `cusr`, skill, gate hay tài liệu làm chậm hoặc làm sai việc, assistant hoặc người dùng
   tạo GitHub issue tiêu đề `dogfood: <vấn đề>`, gồm lệnh đã chạy, kết quả mong đợi, kết quả thực tế, task ID và
   SHA release (`readlink ~/cuesura-dogfood/current`). Ghi cả khi đã có cách né. Không kèm token hay nội dung
   credential. Worker không tạo issue; nếu worker báo vướng thì assistant ghi thay.
2. **Xếp ưu tiên.** Trước mỗi việc mới, assistant đọc `gh issue list --search "dogfood: in:title" --state open`
   rồi đề xuất, người dùng quyết định. Việc chặn đường chính được làm trước feature; lỗi lặp lại lần hai được
   nâng ưu tiên; phần còn lại xếp cùng backlog.
3. **Sửa qua vòng trên.** Mỗi issue thành một task có tiêu chí nghiệm thu, thêm test tái hiện nếu là lỗi code.
   Lỗi cách dùng thì sửa `skills/cusr/SKILL.md`; lỗi quy trình thì sửa file này.
4. **Có hiệu lực khi nâng release.** Skill và CLI đổi cùng lúc, theo cùng SHA. Dùng lại đúng kịch bản đã ghi trong
   issue trên release mới rồi mới đóng issue.

Không tính là cải thiện, và không được làm chỉ để task xanh: nới gate, bỏ test, tăng budget, đổi quyền token,
hoặc tạo task mới để né budget đã cạn. Những thay đổi này phải là PR riêng do người dùng quyết định.

Mỗi tháng, hoặc sau 10 task, xem lại: tỉ lệ task tới PR xanh không cần sửa tay, số lần người dùng phải can thiệp,
số lượt agent trên mỗi PR được merge, và số issue `dogfood:` mở/đóng. Chỉ số xấu đi thì sửa trước khi thêm feature.

## Nâng và lùi release

Chỉ nâng khi `cusr task list` không còn task đang chạy hoặc chờ sửa.

```sh
~/projects/metronome/scripts/dogfood/install-release.sh        # origin/main, hoặc truyền SHA
systemctl --user restart cusrd.service
cusr doctor --project cuesura --json
```

Script xây release mới, đổi `current` một lần và chép skill; process đang chạy vẫn giữ code cũ tới khi restart.
Script lấy code từ `repo/`, không từ repo phát triển.

`doctor` báo `manifest:*` thì pin hoặc layout đã đổi: chứng minh lại harness trước khi chạy task. Không sửa tay
`manifest.json`.

Lùi: truyền SHA cũ cho script rồi restart. Nếu release mới đã migrate DB, bản cũ có thể không mở được DB: dừng
daemon và chép `data/cusr.db` trước mỗi lần nâng có migration. Backup/restore chưa được nghiệm thu, nên coi đây là
biện pháp tốt nhất hiện có, không phải bảo đảm.
