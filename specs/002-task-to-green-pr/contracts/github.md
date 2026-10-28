# Hợp đồng GitHub và quan sát PR

Adapter trả facts, core quyết định trạng thái. [Research R-09/R-10](../research.md) chứa nguồn API
chính thức và các giới hạn; [data model](../data-model.md) định nghĩa facts/completeness. Không có
API merge trong port. Dùng gh api qua port process mỏng theo SPEC §17.2, không fetch backend.
Command allowlist, timeout/transport/pagination/bytes được pin theo runtime snapshot.

## Publish và đối chiếu

| Thao tác | Identity / probe trước retry |
| --- | --- |
| Commit | Checkpoint tree/parent/metadata/OID dự kiến, compare-and-swap local ref |
| Push | Immutable repo ID + source branch + expected-old/new SHA; remote bằng new thì nhận lại, khác cả hai thì unknown/head_changed |
| Create PR | Repo + head owner/branch + target + marker chứa task/revision/operation key; query mọi state, không chỉ PR open |
| Rerun CI | Cụ thể workflow run ID/attempt/head; chỉ khi policy và số lượt cho phép, đối chiếu run generation trước retry |

Một logical operation giữ idem key qua timeout/restart. Không coi marker/title tự nó là đủ quyền
nhận PR; tuple repo/head/base phải khớp. Nhiều PR khớp hoặc remote diverged thì chờ, không tạo PR
thay thế. HTTP 422/timeout sau create không chứng minh thất bại; query/probe trước lần gửi mới.
POST rerun không có idempotency remote: không chứng minh được chưa gửi thì unknown, không lặp bừa.

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
  Protection 200 thiếu hẳn `required_status_checks` nghĩa là không bật status check (trường tùy chọn
  trong schema GitHub; theo schema, **chưa kiểm live**): chỉ nhận khi `url` của body đúng endpoint
  protection của repo/branch đích, provenance `read_no_status_checks`; vẫn phải đọc đủ rules.
  `required_status_checks: null` cũng là không có classic check; body khác/thiếu `url` vẫn unknown.
- Protected branch cần đọc được cả classic protection và active rules áp dụng từ repo/org; rule
  API không thay classic protection. Missing permission/feature response hoặc truncated pages
  không được coi empty. Non-check rules ghi lại nhưng không tuyên bố PR đủ điều kiện merge.
- Project snapshot giữ `string[]` tên check. GitHub không ghim app (absent/null/-1 theo response
  schema được pin) dùng any-app và được bao phủ khi cùng tên có trong snapshot. App ID cụ thể luôn
  required_checks_mismatch; ghi tên/app trong evidence, không thêm FrozenPolicy v2 hoặc key app_id
  vào cusr.yaml. Chỉ người dùng tự đổi rule GitHub thành any-app nếu chấp nhận; Cuesura không tự nới.
- Hai required sets GitHub được hợp để mô tả đầy đủ yêu cầu GitHub; **không** hợp chúng vào snapshot.
  Core kiểm `G ⊆ S` khi G chỉ any-app; phần `G \ S` hoặc app-pinned → required_checks_mismatch. Snapshot thêm
  check vẫn phải pass; không chỉ chạy các check GitHub yêu cầu.
- Check runs và commit statuses cùng được đọc theo đúng SHA. Chọn attempt/generation hiện hành,
  status mới nhất của cùng identity; pending/failure của rerun không được che bằng success cũ.
  Cùng tên nhiều nguồn không ánh xạ rõ hoặc status/check collision không giải được → policy.
- Chỉ success đạt; neutral/skipped/pending/cancelled/missing/unknown không đủ theo spec này.
  Gate/review snapshot còn hiệu lực cùng head vẫn bắt buộc, GitHub no-protection không miễn chúng.

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
không mở lại agent/rerun dù CI pass muộn. Hết task deadline vẫn quan sát trong hạn riêng. Hết hạn
observation là observation_expired, không tự poll lại. Recheck quan sát một lần có dedup, chưa
merge giữ exhausted; thấy merge thì drain theo FR-040, không DONE trước dừng/đối chiếu.

Head ngoài dự kiến, target mismatch, PR đóng, CI rerun và base tip thay đổi tuân FR-041. Chỉ base
tip đổi không tự sửa/rebase/thu hồi evidence theo head. Lỗi read ghi unknown, lần quan sát cuối
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
