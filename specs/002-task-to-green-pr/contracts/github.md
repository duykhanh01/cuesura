# Hợp đồng GitHub và quan sát PR

Adapter trả facts, core quyết định trạng thái. [Research R-09/R-10](../research.md) chứa nguồn API
chính thức và các giới hạn; [data model](../data-model.md) định nghĩa facts/completeness. Không có
API merge trong port. Dùng gh api qua port process mỏng theo SPEC §17.2, không fetch backend.
Command allowlist, timeout/transport/pagination/bytes được pin theo runtime snapshot.

## Method mặc định và merge thủ công

Theo [SPEC §14.2](../../../SPEC.md#142-merge), `cusr.yaml` dự kiến có `merge.method`, mặc định
`squash`, đổi được sang `merge` hoặc `rebase`, đóng băng khi task bắt đầu. Với feature 002, đây
chỉ là lựa chọn đề xuất: port vẫn không có endpoint merge và không kiểm method như điều kiện
admission/hoàn tất. Cung cấp commit message worker đã chuẩn bị cho người dùng dùng khi squash.

Merge thủ công bằng method khác cấu hình vẫn DONE khi proof/drain đạt. Ghi method thực tế và
chênh lệch chỉ khi có bằng chứng đáng tin; không xác minh được thì unknown, không đoán từ graph
hoặc coi thiếu method là proof incomplete. Khác method không làm mất chứng nhận head đã kiểm.
`checked_head_sha`, `merged_head_sha` và `merge_commit_sha` là ba dữ kiện riêng; squash/rebase
không đòi merge commit bằng PR head. V1 khi được phép gửi merge sẽ dùng method frozen và message
artifact hiện hành đã validate, ghi digest vào intent, chờ nếu method không được phép thay vì fallback.

## Publish và đối chiếu

| Thao tác | Identity / probe trước retry |
| --- | --- |
| Commit | Checkpoint tree/parent/metadata/OID dự kiến, compare-and-swap local ref |
| Push | Immutable repo ID + source branch + expected-old/new SHA; remote bằng new thì nhận lại; remote nằm giữa expected-old và new trên lịch sử local (worker đã tự push commit của task) thì nhận làm expected-old rồi push fast-forward; khác nữa thì unknown/head_changed |
| Create PR | Repo + head owner/branch + target + marker chứa task/revision/operation key; title/body từ artifact worker đã validate, digest lưu cùng intent; query mọi state, không chỉ PR open |
| Update PR description | Cùng repo/PR identity, expected previous body và body artifact mới; probe trước retry, thay đổi ngoài dự kiến thì chờ, không ghi đè mù |
| Rerun CI | Cụ thể workflow run ID/attempt/head; chỉ khi policy và số lượt cho phép, đối chiếu run generation trước retry |

Một logical operation giữ idem key qua timeout/restart. Không coi marker/title tự nó là đủ quyền
nhận PR; tuple repo/head/base phải khớp. Nhiều PR khớp hoặc remote diverged thì chờ, không tạo PR
thay thế. Một PR đang mở trên đúng tuple, không có marker nào và head đúng SHA vừa push là PR worker tự
mở cho task: create tiếp quản bằng cách ghi title/body và marker như khi tự tạo, rồi probe lại; PR
đóng, head khác hoặc mang marker khác vẫn là conflict. HTTP 422/timeout sau create không chứng minh thất bại; query/probe trước lần gửi mới.
HTTP 422 mà lỗi validation nêu field `title` hoặc `body` là lỗi nội dung, không phải credentials (issue #249):
create (kể cả khi tiếp quản PR worker tự mở) và update description gửi lại đúng một lần với nội dung đã làm vừa giới hạn GitHub (title bỏ ký tự điều
khiển, tối đa 256 ký tự, rỗng thì `cusr task <id>`; body bỏ NUL, cắt kèm ghi chú để body cuối cùng có marker
không quá 65536 ký tự). Probe nhận cả body gốc lẫn body đã làm vừa của cùng operation. Lần hai vẫn 422 nội
dung thì effect lỗi `invalid_output` và task chờ `publish_content_invalid`; 422 khác và conflict vẫn là
`auth_config`.
POST rerun không có idempotency remote: không chứng minh được chưa gửi thì unknown, không lặp bừa.

Title/body worker là dữ liệu không đáng tin: trước khi ghép, từ chối marker trong namespace
`<!-- cusr:` theo cùng chuẩn hóa của parser. Chỉ orchestrator gắn một block marker canonical
cuối body và ghi digest body cuối vào intent. Probe chỉ nhận block canonical ở vị trí này cùng
repo/head/base/operation receipt, không tìm marker tự do trong nội dung worker hoặc tin title.
Marker giả/nhân đôi/body lệch phải chặn để đối chiếu, kể cả `direct-pr`; kiểm fixture giả mạo
và timeout/recovery nằm trong M05/M07 và T136/T139.

Nội dung template được đọc từ frozen base và đưa cho worker; orchestrator không diễn giải heading
Markdown. Cả hai mode dùng nội dung worker chuẩn bị, marker/source links do orchestrator gắn;
không có writer agent riêng. Nội dung mới sau fixer/CI được đối chiếu theo
[hợp đồng chế độ](../task-execution-modes.md); update PR description cần endpoint allowlist,
receipt/probe và kiểm thử riêng trước khi hỗ trợ, không tự mở quyền GitHub cho worker.

## API read bundle

Pin gh binary/version và API header `2026-03-10`; gọi gh api bằng argv, không shell. Deadline
của process port dừng/reconcile gh và cap bytes/pages/calls; GH_PROMPT_DISABLED=1, pager tắt,
không log auth/env secret. Credential chỉ ở home/env orchestrator, không mount agent. Raw evidence
ghi response/status/digest; gh không quyết định task state hoặc tự reset ngân sách retry.

1. GET `/repos/{owner}/{repo}/pulls/{number}` lấy ID/repo/head/base/state/merged/merged_at.
   PR identity (repo ID, PR ID, target) phải khớp task, không chỉ URL do user nhập. API pin
   `2026-03-10` không còn `merge_commit_sha`; nếu field xuất hiện thì chỉ dùng để đối chiếu.
2. Nếu merged: thu merge proof và head-at-merge theo capability fixture. Không cần đợi CI/rules
   pass để ghi merge; bước 3 chỉ phục vụ chứng nhận/chờ khi chưa merge. Không suy từ mergeable,
   PR closed hoặc branch mất. Merge commit lấy từ `commit_id` của event `merged` trong GET
   `/repos/{owner}/{repo}/issues/{number}/events` (phân trang đủ trong cap). Chỉ nhận khi có đúng
   một merged event, SHA 40 hex, khác `head.sha`/`base.sha`, `commit_url` thuộc repo này,
   `created_at` bằng `merged_at` và khớp `merge_commit_sha` nếu có. Thiếu/truncated → missing/
   unknown; nhiều event hoặc lệch → conflict; sai dạng → invalid. Proof `complete` cần thêm GET
   merge 204, target khớp task và PR đọc lại không đổi; nếu không, giữ fact merged nhưng proof
   `incomplete` kèm gaps. Không suy merge/squash/rebase từ commit graph.
3. Nếu chưa merge: GET branch/protection, `/rules/branches/{target}`, commit check-runs và statuses
   của observed head. Pagination phải đầy đủ trong cap; không đủ → completeness=false/unknown.
4. GET PR lại; bundle head/base/state khác lần đầu thì inconsistent, không báo xanh hoặc dùng
   evidence của hai head trộn nhau. Nhận được merged ở lượt cuối thì chạy nhánh merge proof.

Nếu xác minh merge riêng bằng endpoint `/pulls/{number}/merge`, 204 chỉ bổ trợ merged fact; không
có head/target đủ trong response này. 404 không tự là unmerged khi PR/repo/permission chưa đối chiếu.
Fact merge ghi repo ID/PR ID/target/merged_head/merge_commit/time và nguồn evidence, không gọi PUT merge.

API không hứa snapshot transaction. Fixture sandbox ở lát 0 trước A phải ghi merge/squash/rebase, head ngoài kiểm,
source branch còn/xóa/được push sau merge; đối chiếu PR `.head.sha` với head thật tại merge. Nếu
provider không chứng minh được trường đó ở một trường hợp, trả proof incomplete/unknown theo
FR-040.12, không thay bằng HEAD hiện tại hoặc suy từ merge commit squash.

## Required checks và danh tính

- `github_required=none` chỉ khi branch read thành công xác nhận unprotected, active rules đọc đủ
  không có luật; hoặc đọc đủ classic+rules xác nhận không có required check. Rules `evaluate` không
  phải enforced; lưu provenance và enforcement. 401/403/404 không có bằng chứng hỗ trợ → unknown.
  Ngoại lệ đã kiểm live (S0.3, 2026-10-28): branch chỉ có ruleset vẫn trả `protected: true`, còn
  classic protection trả 404 với body `Branch not protected`; khi đó coi là không có classic và đọc
  tiếp rules. 404 khác body đó (vd `Not Found` do thiếu quyền) vẫn là unknown.
  Mọi body protection 200 (có danh sách check, `null` hay thiếu trường) chỉ được nhận khi `url` của
  body đúng endpoint protection của repo/branch đích; body thiếu/khác `url` là unknown. Thiếu hẳn
  `required_status_checks` nghĩa là không bật status check (trường tùy chọn trong schema GitHub; theo
  schema, **chưa kiểm live**), provenance `read_no_status_checks`; `required_status_checks: null` cũng
  là không có classic check. Cả hai vẫn phải đọc đủ rules.
- Protected branch cần đọc được cả classic protection và active rules áp dụng từ repo/org; rule
  API không thay classic protection. Missing permission/feature response hoặc truncated pages
  không được coi empty. Non-check rules ghi lại nhưng không tuyên bố PR đủ điều kiện merge.
- Project snapshot giữ `string[]` tên check; không thêm key app_id hay sửa FrozenPolicy/hash.
  Mỗi lượt đọc tính hợp snapshot và tên mọi check đang bắt buộc trên GitHub, kể cả app-pinned,
  không phụ thuộc yolo. Lưu `github` và `app_pinned` (name/app/source/ruleset) trong verdict/CI evidence.
- Check ngoài snapshot hoặc ghim app không tạo required_checks_mismatch mới. Schema và wait lịch sử
  giữ nguyên; quan sát tiếp theo áp dụng hợp tên để đi tiếp trong hạn CI; hết hạn thì ci_wait_exhausted, trừ
  khi lượt đó thấy CI pass đủ required checks trên đúng head thì sang chờ merge (FR-043.11).
- GitHub `none` là evidence dương; unknown/thiếu quyền/đọc thiếu không fallback. Cùng tên nhiều nguồn
  không ánh xạ rõ hoặc status/check collision không giải được vẫn chờ policy.
- Hợp rỗng: observation vẫn vào chờ merge, không chờ check tùy chọn; yolo không merge và log một lần
  hướng dẫn khai `ci.required_checks`. Không lấy mọi check đang thấy trên head làm fallback.
- Trước merge mọi check được pin phải đạt từ đúng app_id; token admin có thể bypass protection.
  Đọc tip hiện tại bằng GET branches/{target}, không dùng pull.base.sha.
  Compare dùng `head...target_tip_sha`, `per_page=1&page=2` và `ahead_by === 0`; trang 2 tránh tải diff.
  Nếu ahead_by > 0 và biết base SHA, daemon yêu cầu engine cập nhật local cả khi tắt yolo qua gate/publish/CI;
  không gửi merge trước khi head mới được chứng nhận. Cập nhật dùng Git, giữ endpoint merge gác sha.
- Check đạt khi là success, skipped hoặc neutral, giống branch protection của GitHub (#208);
  cancelled/stale/timed_out/failure/action_required/startup_failure, pending, missing và unknown không đủ.
  skipped/neutral chỉ đạt khi không check hiện hành nào của cùng head (kể cả check không bắt buộc) ở
  failure/timed_out/action_required/startup_failure/cancelled/stale; áp dụng cả lúc xét head lẫn lúc
  kiểm lại trước merge.
  Gate snapshot cùng head luôn bắt buộc; review cùng head bắt buộc trong `full-review`, trừ
  chứng nhận phạm vi tích hợp base theo SPEC.md §14.2: không conflict hoặc một lượt fixer chỉ sửa
  file conflict thì không review mới; ngoài phạm vi phải review, chưa xong/conflict lại chờ người.
  `direct-pr` ghi rõ review không được yêu cầu theo mode đã xác nhận, không giả approve; GitHub
  no-protection không miễn gate/CI hoặc review ngoài ngoại lệ phạm vi trên.

Review callback không xác nhận remote head hiện tại: khi reviewer A đang chạy mà branch task
bị push thành B ngoài dự kiến, observation ghi head_changed và chặn business dispatch (B nằm giữa head
đã push và HEAD của worktree task là commit worker tự push, không phải drift; nó chưa là bằng chứng CI
cho tới khi daemon push); approve A
đến muộn chỉ hoàn tất receipt/lịch sử A, không gỡ blocker hoặc duyệt B. Nếu observation chưa thấy B,
probe trước publish và guard expected-old trong update phải chặn drift; receipt muộn/restart không
route lại bước đã chặn. Chỉ base tip đổi không gây nhánh này.
[H01–H06](../task-execution-modes.md#remote-đổi-head-khi-review-còn-chạy) kiểm cả hai thứ tự callback/observation, probe/push và replay.

## Lịch quan sát và recheck

Observation bắt đầu khi nhận diện PR lần đầu (kể cả nhận lại sau crash), không chỉ lúc PR xanh.
Hạn 30 ngày và tối đa 2.000 lượt tự động; poll từ 60 giây nhân đôi tới 1 giờ. Remote đổi thì cadence
về đầu để thu hồi xanh sớm nhưng không reset hạn/count. Mỗi timer có generation; stale timer/results
chỉ ghi lịch sử nếu phù hợp provenance, không thêm chain hoặc mở workflow quá hạn.

Một lượt tối đa 60 giây/100 HTTP calls; mỗi list tối đa 20 trang × 100 record. Mỗi response tối đa
2 MiB; request tối đa 3 lần gửi trong tổng cửa sổ. Retry-After dài hơn cửa sổ được ghi để hẹn lần
sau trong hạn, không ngủ vượt cap. ETag/304 chỉ tái sử dụng đúng cached evidence, không biến cache
cũ thành bằng chứng đọc đầy đủ endpoint chưa từng thành công.

CI deadline/count riêng từng head: default 1 giờ/60 lượt (hoặc step timeout đóng băng); exhausted
không mở lại agent/rerun/poll. CI pass muộn đủ required checks trên đúng head (quan sát hoặc câu trả
lời poll đến sau hạn) đưa task sang chờ merge; kết quả muộn khác chỉ là bằng chứng (FR-043.11). Hết task deadline vẫn quan sát trong hạn riêng. Hết hạn
observation là observation_expired, không tự poll lại, trừ khi lần đọc cuối thấy PR mở trên đúng
head task: khi đó cửa sổ tự gia hạn (`ObservationExtended`, FR-043.04). Recheck quan sát một lần có dedup, chưa
merge giữ exhausted; thấy merge thì drain theo FR-040, không DONE trước dừng/đối chiếu.

Head ngoài dự kiến, target mismatch, PR đóng, CI rerun và base tip thay đổi tuân FR-041. Chỉ base
tip đổi không thu hồi evidence theo head; task chờ merge tích hợp base theo ngoại lệ SPEC.md §14.2,
không phụ thuộc yolo. Lỗi read ghi unknown, lần quan sát cuối
là lịch sử; explain chỉ rõ freshness và allowed actions, không hứa head mới đã được kiểm.

## Contract fixtures và smoke

Fake HTTP server ghi request ledger và response script cho: tất cả 2xx/401/403/404/422/5xx/timeouts,
pagination cutoff, ruleset inherited/classic, none vs unknown, app identity, status/check collision,
rerun success cũ/pending mới, concurrent head/base change và late push/merge. Test xác nhận zero
merge request kể cả request yolo/approval và legacy effect lạc vào executor.

Prototype `scripts/spike-002/gh.ts` đã có regression từ response API 2026 thật (thiếu
`merge_commit_sha`, merged event hợp lệ) và các case thiếu/truncated/mâu thuẫn; live read-only trên
ba PR sandbox S0.3 cho proof `complete`, xem
[manifest](../../../test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json).
Classic/rules/app-pinned/unknown vẫn chỉ có fixture local.

Smoke GitHub thật ghi repo/PR URL, expected/checked/merged head, merge commit, raw proof hash,
request count và đầy đủ sources. Hai PR acceptance thật không được thay bằng fake-server pass.
Mọi fixture/check chưa chạy phải ghi chưa kiểm, không khai là adapter đã hỗ trợ.
