# Dùng Cuesura để phát triển Cuesura

Quy trình này dùng bản `cusr` đã đóng băng để phát triển bản kế tiếp. Vướng mắc gặp khi dùng được ghi
thành việc, sửa qua chính `cusr`, rồi có hiệu lực ở release sau.

## Ranh giới

- **Agent không merge.** Assistant hỏi người dùng trước khi giao, rồi tự xác nhận run config và chạy task, nhưng không gọi merge. Người dùng duyệt
  và merge mọi PR; khi user config có `yolo: true`, chính daemon merge PR đủ điều kiện
  ([deploy](../deploy/README.md#yolo)). Vòng cải thiện không có đường tắt nào khác.
- **Gate lấy từ commit base.** PR sửa `cusr.yaml` hay CI không tự nới gate cho chính nó.
- **Worker không dùng `cusr`.** Skill chỉ dành cho assistant caller điều phối; worker có thể đọc thấy nó trong repo
  nhưng không được dùng.
- **Một release, một task.** V1 chạy một task tại một thời điểm.

## Bố cục

Repo phát triển giữ nguyên ở `~/projects/metronome`. Phần vận hành nằm riêng ở `~/cuesura-dogfood/`:

| Đường dẫn | Vai trò |
| --- | --- |
| `releases/<sha>/` | Bản build đóng băng; không sửa tay |
| `current` | Symlink tới release đang dùng; `~/.local/bin/cusr*` chạy qua đây |
| `repo/` | Clone riêng của daemon; không làm việc trực tiếp ở đây |
| `data/` | Data dir của daemon |
| `config.yaml`, `prompts/` | User config và prompt role |
| `tools/node/bin/` | Node và pnpm của vận hành; lệnh dùng PATH host và quyền native của harness |

Không chạy daemon từ repo phát triển: checkout hay build ở đó sẽ đổi code của CLI đang chạy, và worktree của
daemon sẽ lẫn vào `git worktree list`.

Skill `cusr` của release nằm ở `~/.claude/skills/cusr` và `~/.codex/skills/cusr`. `cusr init` cũng có thể cài nó vào
`.claude/skills` và `.agents/skills` của repo đích và commit: worker đọc được skill là chấp nhận được, vì đọc
không cho worker thêm quyền nào, và `cusr` từ chối chạy trong worker
([Người gọi và quyền](../deploy/README.md#người-gọi-và-quyền)).

Kết nối cho assistant, lặp lại ở mỗi lệnh theo skill:

```sh
DATA_DIR=~/cuesura-dogfood/data
PROJECT=cuesura
BASE=main
PROFILE=dogfood
```

Skill đặt `CUSR_ACTOR=assistant` ở mỗi lệnh nên daemon giới hạn assistant ở `read/operate`. Cùng UID nên đây
không phải ranh giới quyền thật ([deploy](../deploy/README.md#người-gọi-và-quyền)): việc assistant không bỏ
biến này để gọi như owner là quy tắc, không phải giới hạn kỹ thuật.

## Cài đặt lần đầu (người dùng)

1. Setup từng harness: ghi pin rồi ghi manifest bằng một lệnh, **không gọi model**; chuẩn bị
   credential/settings theo [runbook](../deploy/README.md#harness-thật-pin-và-manifest):

   ```sh
   cd ~/cuesura-dogfood
   cusr-runner setup-harness --config config.yaml --data-dir data --harness claude \
     --vendor claude --binary "$(command -v claude)" \
     --toolchain "$PWD/tools/node/bin" --auth claude-0:.claude/.credentials.json \
     --settings claude-settings.json --permission-mode auto --sandbox off
   ```

   Thay `claude-0` bằng tên credential đã khai trong config và dùng đường dẫn toolchain canonical trên host.
   Thêm `--dry-run` để chỉ kiểm pin dự kiến, không ghi gì; kết quả báo `pin_exists`. Pin đã có cần `--force`
   để thay. Binary chưa cài thì lệnh báo lỗi ở bước `write-pin`. Bước nào lỗi thì dừng ngay và nêu tên bước.
   Dùng `--from record-manifest` để ghi lại manifest với pin đã ghi, ví dụ sau khi thêm role `deputy`.

   Lặp lại cho Codex với `--harness codex --vendor codex --binary "$(command -v codex)"` và auth/rules Codex
   tương ứng; bỏ các cờ riêng Claude (`--settings`, `--sandbox`). Manifest gắn với binary và pin, không gắn với
   model. Harness không gọi được (chưa đăng nhập, hết phiên, binary bị gỡ) lộ ra ở lượt agent đầu tiên: task
   chờ `harness_auth` hoặc `auth_config` kèm lỗi và assistant đã đăng ký được báo ([Vòng làm một việc](#vòng-làm-một-việc)).

   Hai lệnh `write-pin`, `record-manifest` vẫn dùng được riêng; xem
   [runbook](../deploy/README.md#harness-thật-pin-và-manifest).

2. Bật daemon theo [mẫu service](../deploy/README.md#chạy-daemon-foreground-hoặc-service), với `ExecStart`
   trỏ tới `~/cuesura-dogfood/config.yaml` và `~/cuesura-dogfood/data`, thêm
   `Environment=PATH=%h/cuesura-dogfood/tools/node/bin:%h/.local/bin:/usr/bin:/bin`.

3. Kiểm tra `cusr doctor --project cuesura --json` trả `ok: true`. Với `--project`, doctor đọc
   `cusr.yaml` ở `origin/<base>` máy đang có và báo các check `project_config`, `profile`, `gates`,
   `required_checks` của dự án: profile không tồn tại hay thiếu `ci.required_checks` đều làm doctor thất bại; project không khai gate không phải lỗi, mỗi check kèm cách sửa.
   Không có profile mặc định thì chỉ báo thông tin: task phải tự nêu `profile:` trong `--file`.

## Vòng làm một việc

| Bước | Ai | Việc |
| --- | --- | --- |
| 1. Chốt | Assistant, người dùng | Assistant đọc `cusr dispatch`, đưa một bản tóm tắt: tiêu đề, tiêu chí nghiệm thu quan sát được, ngoài phạm vi, worker/mode/reviewer kèm luật đã khớp; người dùng đồng ý hoặc sửa |
| 2. Giao | Assistant | `cusr task add` và `cusr task propose` đúng như bản đã chốt |
| 3. Xác nhận | Assistant | `cusr task confirm --run-config <digest>` với `CUSR_ACTOR=assistant` |
| 4. Chạy | Daemon, worker | Worktree riêng, coder, gate, reviewer nếu `full-review`, tạo PR, chờ CI |
| 5. Theo dõi | Assistant | `cusr assistant register` để hook đánh thức phiên khi task cần người trên Claude Code, Codex và pi ([cài hook](../deploy/README.md#đánh-thức-assistant-bằng-stop-hook)); harness khác dùng `cusr assistant wait` chạy nền; `task explain`, `task logs`, `inbox`; câu hỏi chưa rõ thì chuyển cho người dùng |
| 6. Merge | **Người dùng** | Đọc diff, merge trên GitHub; daemon ghi nhận DONE |
| 7. Cập nhật | Assistant | Kiểm tra task, backup, nâng release và restart theo mục [Nâng và lùi release](#nâng-và-lùi-release) khi có thay đổi cần dùng |

Bỏ bước Chốt chỉ khi người dùng nói rõ cứ giao không cần hỏi; lời đó chỉ áp dụng cho lần giao ấy. Đổi nội dung
task hay run config so với bản đã chốt thì hỏi lại. Bước Chốt là quy tắc cho assistant, không phải giới hạn
của daemon: `CUSR_ACTOR=assistant` vẫn chạy được `task confirm`.

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

### Khi gate và review khác ý nhau

Reviewer được tự chạy typecheck, lint, build hay test; mọi thay đổi nó để lại trong worktree bị daemon trả về
sau lượt review. Ngoài những gì tự chạy, nó dựa vào bằng chứng có sẵn:
phần kiểm tra worker tự báo trong nội dung PR (nếu template PR yêu cầu), và mục `gate_evidence` trong context cho
biết gate đã chạy gì trên đúng commit đang review: từng gate, command, bắt buộc hay tuỳ chọn, kết quả và đuôi log
khi fail. Cùng một kiểm tra mà hai nguồn báo khác nhau thì tin `gate_evidence`. Không có kết quả gate
(`not_configured`, `missing`) thì reviewer dựa vào phần worker tự báo và ghi rõ chưa có gate xác nhận. Thiếu bằng
chứng đã chạy kiểm tra không bao giờ là finding, vì CI chạy sau khi approve; còn kiểm tra được báo mà thay đổi mâu
thuẫn (vd test không có trong worktree) là finding.
`gate_evidence` gồm các trạng thái:

- `passed`/`failed`: kết quả của lượt gate tạo ra checkpoint đó, kể cả gate tuỳ chọn bị fail.
- `not_configured`: project không khai báo gate.
- `missing`: không có lượt gate nào khớp commit đang review.

Mục `worker_reports` chép summary của các lượt coder/fixer trong revision hiện tại kể từ lượt review gần nhất có
verdict (vòng đầu là summary của coder), mỗi mục ghi role, step và attempt; summary đã redact và cắt ở 8.000 ký tự.
Đây là lời worker tự báo, không phải bằng chứng: reviewer kiểm lại trên diff, và `gate_evidence` thắng khi hai bên
khác nhau.

Context của reviewer chỉ có range, digest và danh sách file của thay đổi, không chép nội dung diff; reviewer đọc
bằng `git diff <from> <to>` trong worktree. Reviewer được tách việc cho sub-agent (Claude qua tool `Agent`,
Codex qua `spawn_agent`).

Nhận xét review nói "không chạy được test", "môi trường chỉ đọc" hay "không khởi tạo được sub-agent" là nhiễu,
không phải lý do sửa code: đối chiếu kết quả gate trong `task explain` và ghi issue theo
[Vòng tự cải thiện](#vòng-tự-cải-thiện). Review từ chối vì tiêu chí nghiệm thu nằm ngoài phạm vi task là lỗi giao
việc: hủy và giao lại với tiêu chí nghiệm thu được trong chính diff của task.

### Chọn model

Assistant đề xuất theo bảng trong bản tóm tắt ở bước Chốt, nêu lý do ở `--reason`, rồi tự xác nhận sau khi người dùng đồng ý; người dùng chỉ định khác thì làm theo. Không chắc thì chọn
mức cao hơn. Không đổi binding sau khi task đã chạy: muốn đổi thì tạo task mới.

| Mức | Khi nào | `--worker` | Mode |
| --- | --- | --- | --- |
| Mặc định | Code thường, logic có rẽ nhánh, sửa nhiều file, không chắc thuộc mức nào | `claude/opus/medium` | `full-review` |
| Nhẹ | Thay đổi nhỏ, phạm vi rõ, có test sẵn hoặc dễ thêm test; lỗi đã biết nguyên nhân | `codex/terra/medium` hoặc `claude/sonnet/medium` | `direct-pr`, thêm review nếu đụng logic trong `src/` |
| Lặt vặt | Việc gần như cơ học: đổi tên, sửa thông báo, định dạng, sửa fixture | `codex/luna/high` | `direct-pr` |

Reviewer của mọi `full-review` là `codex/sol/high`.

- **Vùng nhạy cảm luôn dùng mức mặc định:** `src/runner`, `src/daemon`, `src/adapters`, `cusr.yaml`, `.github`,
  `deploy` hoặc quyền, sandbox. Với vùng này, `full-review` là bắt buộc và người dùng chạy `pnpm test` trên host
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
người dùng không cần chép lệnh dài hay chạy thay assistant. `--worker` phải khớp đúng một binding đã khai,
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

Không tính là cải thiện, và không được làm chỉ để task xanh: nới gate, bỏ test, đổi quyền của assistant. Những thay đổi này phải là PR riêng do người dùng quyết định.

Mỗi tháng, hoặc sau 10 task, xem lại: tỉ lệ task tới PR xanh không cần sửa tay, số lần người dùng phải can thiệp,
số lượt agent trên mỗi PR được merge, và số issue `dogfood:` mở/đóng. Chỉ số xấu đi thì sửa trước khi thêm feature.

## Nâng và lùi release

Chỉ nâng khi `cusr task list` không còn task đang chạy hoặc chờ sửa, trừ task đã tạm dừng.

Assistant được thực hiện bước nâng/restart khi người dùng đã giao việc vận hành. Trước khi đổi config,
pin hoặc release: kiểm tra cả `task list` và `status` (không còn operation in-flight hay slot đang giữ).
Chặn task mới trước: `cusr queue pause --reason "nâng release"`. Còn task đang chạy thì tạm dừng thay
vì hủy: `cusr task pause <id> --reason "nâng release" --expected-version N` (thêm `--now` nếu không
chờ lượt agent đang chạy xong; lượt đó chạy lại trong session mới khi resume). Việc đã giao (lượt agent, gate, publish đang chạy) chạy nốt; bước kế tiếp chờ
`paused` và slot được trả lại. Nâng khi các task đó không còn operation in-flight, rồi
`cusr task resume <id> --expected-version N` để chạy tiếp đúng bước đã dừng, cùng revision, worktree,
PR và bằng chứng, rồi `cusr queue resume`. Snapshot đã đóng băng của task (config, model, manifest) không đổi khi resume. Không tự
hủy task để nâng. Dừng service và backup DB/config/pin trước khi nâng;
sau khi tạo lại manifest và restart, kiểm tra lại `doctor`, `status` và chạy task nghiệm thu.

Thứ daemon đọc lại trực tiếp và thứ cần restart:

| Đọc lại trực tiếp, không cần restart | Cần restart `cusrd` |
| --- | --- |
| Config người dùng (role, model, profile, kể cả role `deputy`), đọc khi xác nhận task mới và mỗi lượt deputy | `runtime.tool_paths`, `runtime.credential_refs`, `runtime.terminal` |
| `cusr.yaml` của dự án, đọc ở base khi xem `task options` và khi bắt đầu task | Pin và manifest harness (`harnesses/<h>/pin.json`, `manifest.json`): daemon nạp lúc khởi động |
| `yolo`, đọc trước khi daemon xét merge | Binary harness và release `cusrd` |

Sau `setup-harness` hoặc `record-manifest`, manifest mới chỉ nằm trên đĩa cho tới khi restart:
`doctor` so manifest trên đĩa với manifest daemon đang giữ và báo `manifest:<h>` (cùng `deputy` nếu
harness đó chạy deputy) kèm cách sửa là restart, không phải ghi lại manifest. Ngược lại, daemon còn giữ
manifest mà bản trên đĩa mất hoặc hỏng thì doctor cũng thất bại, vì restart sẽ làm harness mất manifest:
khôi phục file hoặc ghi lại manifest trước khi restart. Không thay snapshot của task cũ. Assistant tự duyệt escalation (`task approve --kind
escalation`, quyền operate) vì nấc đó đã nằm trong ladder người dùng cấu hình; duyệt nhận PR có sẵn
(`--kind adopt`) vẫn cần người dùng chạy bằng quyền admin.

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
harness record thì script dừng, `current` giữ nguyên và in lệnh ghi lại manifest: sửa config, hoặc chạy
`setup-harness` bằng `node releases/<sha>/dist/cli/cusr-runner.js` rồi chạy lại script. Release mới chỉ đổi cách
dựng layout chạy của role (pin, binary và settings không đổi) thì không cần ghi lại: layout không còn là
điều kiện của record. Binary hoặc pin đổi mà tham số pin giữ nguyên thì dùng `--from record-manifest`; đổi tham số
pin thì chạy đủ tham số như khi cài đặt, thêm `--force`. `--allow-unproven` đổi `current` dù task mới sẽ bị chặn.
Script lấy code từ `repo/`, không từ repo phát triển.

`doctor` và `check-records` báo `manifest:*` khi pin, binary hoặc settings của release đang chạy khác lúc ghi manifest: ghi lại manifest trước khi chạy task. Không sửa tay
`manifest.json`.

Mỗi lần ghi lại sinh manifest mới với hash mới. Task chưa bắt đầu chạy nhận manifest mới khi bắt đầu.
Task đã bắt đầu giữ hash manifest trong snapshot. Manifest mới vẫn đáp ứng yêu cầu task đã chốt (schema
kết quả của các role, không capability nào `unsupported`, không `external_verified`) thì task tự nhận và chạy
lại bước đó. Không đáp ứng thì lượt agent kế tiếp không chạy mà chờ `manifest_changed` (harness, hash cũ, hash
mới). Kiểm tra manifest mới là lượt ghi mình đã chạy, rồi chạy `cusr task recheck <id>`: task nhận manifest
mới và chạy lại bước đó, không cần hủy hay tạo lại task.

Lỗi đăng nhập harness (`WAITING/policy harness_auth`): đăng nhập lại vào đúng file trong
`runtime.credential_refs` (Claude: `~/.claude/.credentials.json`, không phải profile Claude đang dùng
để phát triển) rồi `cusr task recheck <id>`. Task cũ còn chờ `loop_exhausted` mà các lượt cuối đều lỗi hạ tầng hoặc đăng nhập
cũng dùng `recheck` để lấy lại visit (task mới tự lấy lại); xem [Phiên đăng nhập harness](../deploy/README.md#phiên-đăng-nhập-harness).

Task hết nấc (vượt nấc cuối, nấc kế bị `denied`, hoặc binding ngoài run config đã xác nhận) kết thúc `FAILED`
với lý do trong `cusr task show` (`ladder_exhausted:<step>`, ...); PR đã mở giữ nguyên để xem, chưa có PR thì phần việc
dở được đẩy lên thành PR draft `[failed] ...` (lý do ghi số PR, hoặc vì sao không mở). Lượt ghé mất vì
hạ tầng/đăng nhập được tự trả, không cần `recheck`.

Task hết lượt nâng (`escalations_exhausted`) hoặc `loop_exhausted` do lỗi chất lượng: xem lỗi review/gate gần nhất, nếu muốn giữ model hiện tại thì chạy `cusr task continue <id>
--expected-version N` (quyền operate, assistant tự chạy được). Bước đang chờ được thêm một đợt `quality_tries_per_rung` lượt thử và đủ lượt ghé
rồi chạy lại từ chỗ dừng; gate và review vẫn chạy, budget, deadline và sàn model giữ nguyên. Hết đợt đó thì task lại chờ.
Muốn đổi sang model khác thì dùng `cusr task amend-policy <id> --model M [--effort E]`: lệnh không có `--confirm` chỉ
xem trước (nấc, binding thêm/thay, nấc có cần approval không, `policy_hash` mới; assistant chạy được để chuẩn bị).
Người dùng áp dụng bằng `--confirm <policy_hash> --reason TEXT --expected-version N` (chỉ owner). Model ngoài
`allow_models` của profile bị từ chối; model trên `auto_up_to_tier` thì task chờ approval escalation như thường.
`review_repeated` và `fix_no_src_change` không còn chờ người: engine tự trả lời thay và fixer chạy lại với ghi chú.
Task cũ còn chờ câu hỏi `review_repeated` thì trả lời như trước, không cần `task continue` thêm.

Lùi: truyền SHA cũ cho script rồi restart. Nếu release mới đã migrate DB, bản cũ có thể không mở được DB: dừng
daemon và chép `data/cusr.db` trước mỗi lần nâng có migration. Backup/restore chưa được nghiệm thu, nên coi đây là
biện pháp tốt nhất hiện có, không phải bảo đảm.
