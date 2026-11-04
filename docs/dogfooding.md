# Dùng Cuesura để phát triển Cuesura

Quy trình này dùng bản `cusr` đã đóng băng để phát triển bản kế tiếp. Vướng mắc gặp khi dùng được ghi
thành việc, sửa qua chính `cusr`, rồi có hiệu lực ở release sau.

## Ranh giới

- **Agent không merge.** Assistant tự xác nhận run config và chạy task, nhưng không gọi merge. Người dùng duyệt
  và merge mọi PR; khi user config có `yolo: true`, chính daemon merge PR đủ điều kiện
  ([deploy](../deploy/README.md#yolo)). Vòng cải thiện không có đường tắt nào khác.
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

1. Setup từng harness: ghi pin, chứng minh rồi ghi manifest bằng một lệnh. Bước chứng minh gọi model thật
   và tốn usage; chuẩn bị credential/rule/settings theo [runbook](../deploy/README.md#harness-thật-pin-và-manifest):

   ```sh
   cd ~/cuesura-dogfood
   cusr-runner setup-harness --config config.yaml --data-dir data --harness claude \
     --vendor claude --binary "$(command -v claude)" \
     --toolchain "$PWD/tools/node/bin" --auth claude-0:.claude/.credentials.json \
     --settings claude-settings.json --permission-mode auto --sandbox off \
     --tools Bash,Read,Edit,Write,Glob,Grep --model claude-haiku-5-5 --effort low \
     --max-invocations 9 --approval "<ai duyệt, ngày>" --out evidence-claude.json
   ```

   Thay `claude-0` bằng tên credential đã khai trong config và dùng đường dẫn toolchain canonical trên host.
   Thêm `--dry-run` để xem `invocations_spent` và `invocations_needed`, không gọi model hoặc ghi pin,
   evidence, manifest hay ledger. Lượt proof thật bắt buộc có `--approval` và `--max-invocations`;
   giới hạn tính cả lượt đã ghi trong ledger cho cùng binary. Lệnh kiểm đầy đủ kế hoạch proof và cap
   trước khi ghi pin; preflight bị từ chối giữ nguyên pin/manifest cũ, kể cả có `--force`.
   Pin đã có cần `--force` để thay thế khi chạy thật; dry-run không cần cờ này và báo `pin_exists`
   để biết trước trạng thái pin. Proof vẫn kiểm lại ledger nếu usage thay đổi sau preflight.
   Bước nào lỗi thì dừng ngay và nêu tên bước; proof thất bại không ghi manifest.
   Dùng `--from prove-harness` để chạy lại proof với pin đã ghi, không pin lại;
   dùng `--from record-manifest --out <evidence.json>` nếu chỉ bước ghi manifest lỗi. Bước này kiểm
   evidence có sẵn, không gọi model và không cần model/approval/cap/force. Config được nạp một lần
   cho cả luồng để các bước dùng cùng cấu hình.

   Proof chạy bốn role `coder`, `fixer`, `reviewer`, `decider`, tốn 4 lượt cho mỗi harness
   (thêm `--prove-resume` cho Claude thì cần 5 lượt). `--model` và `--effort` áp dụng chung cho cả bốn role.
   Proof chỉ kiểm sandbox layout, xác thực và các thao tác cơ học của role, không kiểm chất lượng code,
   nên dùng model rẻ nhất với effort `low`; model của proof không cần trùng model role dùng khi chạy task.

   Lặp lại cho Codex với `--harness codex --vendor codex --binary "$(command -v codex)"`,
   `--model gpt-6-luna --effort low`, auth/rules Codex tương ứng và `--out evidence-codex.json`;
   bỏ các cờ riêng Claude (`--settings`, `--sandbox`, `--tools`). Manifest gắn với binary và pin, không gắn
   với model, nên các model còn lại trong bảng [Chọn model](#chọn-model) chạy được mà chưa có lượt chứng minh
   riêng. Coi task đầu tiên của mỗi model là lần kiểm thật của nó.

   Ba lệnh `write-pin`, `prove-harness`, `record-manifest` vẫn dùng được riêng để gỡ lỗi hoặc chạy lại
   từ bước lỗi; xem [runbook](../deploy/README.md#harness-thật-pin-và-manifest).

2. Bật daemon theo [mẫu service](../deploy/README.md#chạy-daemon-foreground-hoặc-service), với `ExecStart`
   trỏ tới `~/cuesura-dogfood/config.yaml` và `~/cuesura-dogfood/data`, thêm
   `Environment=PATH=%h/cuesura-dogfood/tools/node/bin:%h/.local/bin:/usr/bin:/bin`.

3. Kiểm tra `cusr doctor --project cuesura --json` trả `ok: true`.

## Vòng làm một việc

| Bước | Ai | Việc |
| --- | --- | --- |
| 1. Giao | Assistant | `cusr task add` với tiêu chí nghiệm thu quan sát được, kèm đề xuất run config và lý do |
| 2. Xác nhận | Assistant | `cusr task confirm --run-config <digest>` bằng token của assistant |
| 3. Chạy | Daemon, worker | Worktree riêng, coder, gate, reviewer nếu `full-review`, tạo PR, chờ CI |
| 4. Theo dõi | Assistant | `task explain`, `task logs`, `inbox`; câu hỏi chưa rõ thì chuyển cho người dùng |
| 5. Merge | **Người dùng** | Đọc diff, merge trên GitHub; daemon ghi nhận DONE |
| 6. Cập nhật | Assistant | Kiểm tra task, backup, nâng release và restart theo mục [Nâng và lùi release](#nâng-và-lùi-release) khi có thay đổi cần dùng |

`task logs` đọc phần đuôi đã redacted từ spool của worker đang chạy. Phần live này không tăng
`task.version` hay ghi event theo từng tick, nên không làm stale version vừa đọc để hủy task. Khi run kết
thúc, ingest giữ nguyên thứ tự/cursor của các record đã xem. Các thay đổi trạng thái thật vẫn tăng version.
Lỗi spool xuất hiện trong journal, `status.recovery.spool_problems` và check `spools` của `doctor`;
daemon kiểm tra tiếp từ vị trí đã đọc trong bộ nhớ, rồi xóa báo lỗi khi spool được khôi phục.
Nếu đuôi live hỏng, `task logs` vẫn trả các batch đã commit đọc được, kèm gap có `records: 0`;
gap này không tăng cursor. CLI/TUI chờ lần đọc tiếp theo tại cùng cursor. Log live của attempt sau
chờ ingest xong phần còn thiếu của attempt trước để cursor không lệch khi retry thành công.
Nếu spool vẫn hỏng khi worker kết thúc, kết quả không được commit và operation ở `unknown`.
Người vận hành cần kiểm tra journal và sửa/khôi phục spool trước khi recovery có thể tiếp tục;
daemon không tự bỏ qua log hỏng để chấp nhận kết quả.

Trong JSONL của `task logs --follow`, gap tạm thời là thông báo `diagnostic: "log_gap"`
có `cursor`, `operation_id`, `attempt_id`, `reason` và không có `seq`. CLI chỉ in lại khi operation
hoặc lý do thay đổi, hoặc lỗi xuất hiện lại sau khi đã hết. Record thật sau khi khôi phục vẫn giữ
`seq` ban đầu. TUI hiện `Log temporarily unavailable` thay vì báo mất 0 record.

### Chọn model

Assistant đề xuất theo bảng, nêu lý do ở `--reason`, rồi tự xác nhận; người dùng chỉ định khác thì làm theo. Không chắc thì chọn
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
- **Nâng mức khi vướng:** task của mức nhẹ hoặc lặt vặt sửa sai hai lần thì hủy, tạo task mới ở mức cao hơn với lý
  do ghi rõ.
- **Gemini 3.8 Flash (`gemini-3.8-flash-high`):** cân nhắc cho việc lặt vặt, nhưng **chưa chạy được qua `cusr`** vì
  harness hiện chỉ có Claude và Codex. Trước khi có adapter, dùng `agy` thủ công trong worktree riêng theo
  [AGENTS.md](../AGENTS.md), rồi tạo PR như thường.

Muốn thêm hoặc đổi model: sửa `models` và `binding` của `coder`, `fixer`, `reviewer` trong `config.yaml`, sửa bảng
trên. Assistant kiểm tra không còn task đang chạy hoặc chờ sửa, rồi restart daemon và chạy `doctor`;
người dùng không cần chép lệnh dài hay đưa owner token. `--worker` phải khớp đúng một binding đã khai,
theo dạng `harness/tên-model/effort`.

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

Không tính là cải thiện, và không được làm chỉ để task xanh: nới gate, bỏ test, đổi quyền token. Những thay đổi này phải là PR riêng do người dùng quyết định.

Mỗi tháng, hoặc sau 10 task, xem lại: tỉ lệ task tới PR xanh không cần sửa tay, số lần người dùng phải can thiệp,
số lượt agent trên mỗi PR được merge, và số issue `dogfood:` mở/đóng. Chỉ số xấu đi thì sửa trước khi thêm feature.

## Nâng và lùi release

Chỉ nâng khi `cusr task list` không còn task đang chạy hoặc chờ sửa.

Assistant được thực hiện bước nâng/restart khi người dùng đã giao việc vận hành. Trước khi đổi config,
pin hoặc release: kiểm tra cả `task list` và `status` (không còn operation in-flight hay slot đang giữ).
Nếu còn việc thì hoãn cập nhật, không tự hủy task. Dừng service và backup DB/config/pin trước khi nâng;
sau khi tạo lại manifest và restart, kiểm tra lại `doctor`, `status` và chạy task nghiệm thu.

Config được đọc lại khi xác nhận task mới; `yolo` được đọc lại trước khi daemon xét merge. Thay đổi
token, công cụ, credential reference, pin/manifest hay binary cần restart để các thành phần trong process
dùng cùng cấu hình. Không thay snapshot của task cũ. Escalation vẫn cần người dùng chạy `task approve`
bằng quyền admin; token assistant chỉ có read/operate.

Profile mới không còn `budgets`: task mới không có trần số lượt agent hoặc deadline chung, nên không
cần `amend-policy` để tăng budget. Giữ lịch sử/snapshot của task cũ nguyên trạng. Giới hạn retry theo
loại lỗi, stall timeout và lệnh hủy vẫn áp dụng.

```sh
~/projects/metronome/scripts/dogfood/install-release.sh        # origin/main, hoặc truyền SHA
systemctl --user restart cusrd.service
cusr doctor --project cuesura --json
```

Script xây release mới, đổi `current` một lần và chép skill; process đang chạy vẫn giữ code cũ tới khi restart.
Trước khi đổi `current`, script chạy `cusr-runner check-records` của release mới. Release mới từ chối config hoặc
harness record thì script dừng và `current` giữ nguyên: sửa config, hoặc chạy `setup-harness --force`
với các tham số pin/proof như khi cài đặt bằng `node releases/<sha>/dist/cli/cusr-runner.js` rồi chạy lại script. `--allow-unproven` đổi `current` dù task mới sẽ bị chặn.
Script lấy code từ `repo/`, không từ repo phát triển.

`doctor` báo `manifest:*` thì pin hoặc layout đã đổi: chứng minh lại harness trước khi chạy task. Không sửa tay
`manifest.json`.

Mỗi lần chứng minh lại sinh manifest mới với hash mới. Task chưa bắt đầu chạy nhận manifest mới khi bắt đầu.
Task đã bắt đầu giữ hash manifest trong snapshot, nên lượt agent kế tiếp không chạy mà chờ `manifest_changed`
(harness, hash cũ, hash mới). Kiểm tra manifest mới là lượt proof mình đã duyệt, rồi chạy
`cusr task recheck <id>`: task nhận manifest mới và chạy lại bước đó, không cần hủy hay tạo lại task.

Lỗi đăng nhập harness (`WAITING/policy harness_auth`): đăng nhập lại vào đúng file trong
`runtime.credential_refs` (Claude: `~/.claude/.credentials.json`, không phải profile Claude đang dùng
để phát triển) rồi `cusr task recheck <id>`. Task `loop_exhausted` mà các lượt cuối đều lỗi hạ tầng hoặc đăng nhập
cũng dùng `recheck` để lấy lại visit; xem [Phiên đăng nhập harness](../deploy/README.md#phiên-đăng-nhập-harness).

Lùi: truyền SHA cũ cho script rồi restart. Nếu release mới đã migrate DB, bản cũ có thể không mở được DB: dừng
daemon và chép `data/cusr.db` trước mỗi lần nâng có migration. Backup/restore chưa được nghiệm thu, nên coi đây là
biện pháp tốt nhất hiện có, không phải bảo đảm.
