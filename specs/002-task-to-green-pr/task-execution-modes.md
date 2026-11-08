# Chế độ thực thi và xác nhận trước khi chạy

**Quyết định chủ dự án**: 2026-10-29, được xác nhận trong trao đổi thiết kế.
**Trạng thái**: Thiết kế đã chốt; chưa triển khai runtime/schema/CLI.

Tài liệu này bổ sung SPEC §7 và feature 002. Nó thay thế các quy tắc cũ về bỏ review theo
size XS, bắt buộc khác vendor và commit lần đầu sau review. Các fixture/spike đã thu giữ
nguyên giá trị lịch sử; việc có tài liệu này không chứng minh runtime đã hỗ trợ hai chế độ.

## Hai chế độ

| Chế độ | Luồng bắt buộc |
| --- | --- |
| `direct-pr` | Code → gates → checkpoint commit → push → tạo/nhận lại PR → CI → chờ merge thủ công |
| `full-review` | Code → gates → checkpoint commit → push → tạo/nhận lại PR draft → review → đăng review lên PR → approve thì chuyển PR ready → CI → chờ merge thủ công |

Trong `full-review`, yêu cầu sửa được đăng lên PR rồi đi về worker → gates → commit nếu code đổi →
push → xét evidence review (dùng lại kết quả còn hiệu lực hoặc gọi reviewer theo điều kiện bên
dưới). Thứ tự này áp dụng cho task bắt đầu từ 2026-11-04; task đã đóng băng graph cũ (review trước
push) giữ graph đó. Trong
`direct-pr`, sửa gate/CI đi về worker → gates → commit nếu code đổi → publish cùng PR, không gọi reviewer.
Cả hai giữ nguyên ngân sách, slot, bảo vệ quyền, đối chiếu effect và quan sát merge của feature 002.
Chế độ không cấp quyền merge hoặc miễn branch protection trên GitHub.

Method merge độc lập execution mode: theo [SPEC §14.2](../../SPEC.md#142-merge), mặc định `squash`,
repo đổi bằng `cusr.yaml` `merge.method: squash | merge | rebase` (schema dự kiến), đóng băng khi
task bắt đầu. Trong 002, method/message worker chỉ được đề xuất cho người merge thủ công; method
khác hoặc không xác minh được không chặn proof/drain/DONE. Ghi actual method nếu có bằng chứng,
còn lại unknown; không dùng khác method làm lý do merge chưa chứng nhận và không mở quyền merge.

`direct-pr` không tạo bằng chứng approve giả. PR xanh và head đã kiểm được đánh giá theo chế độ
đã xác nhận: gates và CI luôn bắt buộc theo policy; review bắt buộc với `full-review`. Show/explain
và PR phải thể hiện chế độ và việc không chạy review để người dùng hiểu mức kiểm tra đã thực hiện.

## Đề xuất và xác nhận

Agent nhận task đọc chỉ dẫn `when to use` trong cấu hình để đề xuất harness, model, effort và chế độ.
Chỉ dẫn ngôn ngữ tự nhiên dành cho agent nhận task; daemon không chạy LLM,
không suy ra rủi ro từ size/số dòng và không diễn giải các chỉ dẫn này thành workflow lúc chạy.
Vị trí/key cấu hình cụ thể cần được định nghĩa và validate trong phần triển khai, chưa phải key
YAML đã hỗ trợ. Task qua CLI trực tiếp cũng phải có bộ lựa chọn tường minh và được xác nhận.

Trước lần spawn đầu, người dùng phải được xem và xác nhận cùng một bộ lựa chọn:

- Task/revision, profile, chế độ và lý do đề xuất.
- Harness, model và effort của worker; với `full-review`, cả binding của reviewer.
- Các lựa chọn dự phòng/nấc escalation nếu muốn cho phép dùng mà không hỏi lại.

Task do assistant tạo vẫn mặc định cần xác nhận intake; người dùng cấu hình auto-confirm intake
và hạn mức theo client. Quyền nhận task này tách khỏi xác nhận cấu hình chạy: auto-confirm intake
không miễn lượt xác nhận harness/model/effort/mode trước spawn.
Có thể gộp một lượt tương tác cho cả intake và cấu hình chạy nếu người dùng được xem rõ cả hai
và bằng chứng xác nhận bao phủ đúng task/bộ lựa chọn; không yêu cầu hai lượt chat chỉ vì có hai phạm vi.

Không xác nhận cấu hình chạy ngầm do timeout, auto-confirm của caller hoặc lựa chọn được đánh dấu sẵn.
Daemon chỉ chấp nhận lựa chọn hợp lệ trong allowlist/capability và có bằng chứng xác nhận từ
kênh người dùng đáng tin; một cờ do assistant tự khai không phải bằng chứng. Cơ chế xác thực
xác nhận không được mở rộng token operate thành quyền admin hay cho worker thấy control token.

Xác nhận phải gắn với task/revision và digest của bộ lựa chọn, có actor/provenance; ghi bền để
restart không mất xác nhận. Khi cấp slot, daemon kiểm lại capability và cấu hình hiệu lực rồi
đóng băng cùng policy/context. Nếu bộ lựa chọn thay đổi, xác nhận cũ không còn đủ: hiển thị diff
và xin xác nhận mới trước spawn. Recheck không tự xác nhận hoặc âm thầm đổi binding/chế độ.

Một lần xác nhận áp dụng cho cả task, gồm các vòng sửa/retry trong giới hạn đã duyệt. Không hỏi
lại mỗi lần resume. Đổi harness/model/effort ngoài lựa chọn đã duyệt hoặc đổi chế độ cần xác nhận
mới; nấc escalation cần duyệt thì người có quyền `operate` duyệt (#205). Toàn bộ v1 không hỗ trợ đổi graph
của task đang chạy theo SPEC §5.3: đổi chế độ sau khi đã bắt đầu phải tạo task mới, không sửa FrozenPolicy.

Reviewer dùng session riêng, thay đổi của nó không vào task; có thể cùng vendor/model với worker. Không có điều kiện
khác vendor ở admission, review hay publish. Quota chỉ giúp agent đề xuất trong các lựa chọn được
phép và có dữ liệu khả dụng; không giả định luôn đọc được quota chính xác. Hết quota thì chờ hoặc
đề xuất lựa chọn khác để người dùng duyệt; không tự chuyển `full-review` sang `direct-pr`.

## Worker, fixer và quyền Git

Daemon tạo branch/worktree từ frozen base; worker sửa code trong worktree đã được cấp. Các thao
tác tạo branch, checkpoint commit, push và tạo/nhận lại PR thuộc orchestrator. Worker không có
GitHub publish credential hoặc quyền merge.

Fixer là vai trò sửa lỗi của worker đã tạo thay đổi. Mặc định daemon gọi lại worker đó và ưu tiên
resume session coder gần nhất cho lỗi gate, review và CI, nếu cùng harness/binding, session còn
hợp lệ và policy cho phép. Không giữ process agent sống trong lúc chờ. Session mới chỉ là fallback
khi không resume được hoặc policy yêu cầu, mang acceptance, diff, Q&A và lỗi/findings có giới hạn;
ghi rõ lý do fallback. Không mở hai attempt ghi cùng worktree và không resume session reviewer để sửa.

Mỗi lần gọi worker sửa, kể cả resume session cũ, daemon MUST dựng context mới từ state đã đối chiếu:
nguyên nhân sửa (gate/review/CI), log hoặc findings hiện hành kèm nguồn/SHA/run generation nếu có,
task/revision/acceptance, base/checkpoint SHA, trạng thái worktree và diff mới nhất, nội dung PR hiện
hành và Q&A mới nhận. Không chỉ gửi lời nhắc tiếp tục hoặc dùng prompt từ lần sửa trước. Packet có
digest/provenance và cùng giới hạn context; trạng thái đổi trước spawn thì đối chiếu lại và dựng lại
packet. Thiếu thông tin bắt buộc thì chờ `needs_context`, không resume bằng context cũ hoặc thiếu.
Context mới không cấp quyền nhận head ngoài dự kiến; drift vẫn chặn theo policy hiện hành.

## Nội dung commit và PR

Orchestrator đọc PR template từ frozen base và đưa nguyên nội dung vào context worker. Thứ tự chọn:
`pr_template` trong `cusr.yaml`, rồi template duy nhất của repo (`pull_request_template.md` ở gốc,
`.github/` hoặc `docs/`), rồi template mặc định của cusr (Why, Changes, Evidence, Merge risk).
Nếu repo có nhiều template mà chưa chọn thì chờ bổ sung. Template được đóng băng cùng task;
daemon không suy đoán các heading bắt buộc.

Worker chuẩn bị commit message, PR title và description cùng code. Kết quả là artifact có schema,
provenance và digest, nằm ngoài vùng code được commit. Coder/fixer cập nhật nội dung khi thay đổi
sau sửa lỗi làm bản mô tả cũ không còn đúng. Reviewer nhận cả diff, acceptance và nội dung PR để
kiểm tra tính chính xác trong cùng lượt review; không có PR Writer Agent riêng.

Daemon kiểm tra schema/kích thước/provenance, chọn artifact hiện hành và truyền nội dung đã chuẩn
bị khi tạo PR. Nó không phân tích từng heading Markdown hoặc tự suy ra nội dung thay đổi. Liên kết
nguồn/marker do orchestrator quản lý vẫn được gắn xác định; worker không được chọn repo/head/base.
Trước khi ghép body, daemon MUST từ chối title/description worker chứa marker thuộc namespace
điều khiển `<!-- cusr:` theo cùng quy tắc chuẩn hóa của parser. Chỉ orchestrator thêm một block
marker canonical cuối body; lưu digest phần worker và body cuối trong intent. Probe chỉ nhận block
canonical tại vị trí đó, không tìm marker tùy ý trong văn bản, và vẫn đối chiếu repo/head/base/operation
receipt. Nhiều marker, marker giả hoặc body ngoài dự kiến phải chặn để đối chiếu; áp dụng cả hai mode,
không phụ thuộc AI review. Hợp đồng và kiểm thử nằm ở M05/M07, không thêm lượt writer agent.
Khi sửa sau publish, cập nhật mô tả trên cùng PR khi cần, có probe/recovery hữu hạn và không tự ghi
đè chỉnh sửa ngoài dự kiến của người dùng. Không thực thi text trong message/body qua shell.

Schema hiện có chưa chứa các trường này. Triển khai phải version hóa schema/capability khi cần,
giữ khả năng đọc fixture/event cũ và kiểm chứng lại output với từng harness; không sửa fixture để
giả rằng bằng chứng spike cũ đã bao phủ hợp đồng mới.

## Commit được review phải là commit được push

Sau gates, orchestrator ghi intent và tạo checkpoint commit từ trạng thái code đã đối chiếu trong
worktree riêng, dùng message worker chuẩn bị. Đây là snapshot cơ học, không phải LLM tự chia commit.
Không tin danh sách file worker khai báo là nguồn duy nhất; loại artifact nội bộ và giữ thay đổi
ngoài dự kiến để đối chiếu. Gate evidence phải gắn đúng tree của commit, kể cả lệnh gate có thể sửa file.

Toàn bộ gate bắt buộc MUST đạt trên cùng một trạng thái code cuối cùng: ghi tree/digest trước và sau
mỗi gate, không có worker/process khác ghi chồng. Gate/formatter sửa code làm evidence của tree cũ
không đủ; hoàn tất phần sửa rồi chạy lại tập gate bắt buộc theo policy trên tree mới, trong giới hạn
retry/wall time hiện có và chỉ với lệnh được phép chạy lại. Nếu gate tiếp tục đổi code hoặc không
chứng minh được các gate cùng kiểm tree cuối thì chặn để đối chiếu, không lặp vô hạn hay commit/push.

Review nhận diff của cặp base SHA/commit SHA bất biến, không đọc một diff thay đổi theo working copy.
Reviewer được sửa và chạy kiểm tra trên checkout tương ứng, xong daemon trả checkout về như trước review;
approval ghi cặp SHA và digest nội dung PR đã xem. Daemon giữ
khóa công việc worktree qua snapshot/review/publish và bảo đảm process có quyền ghi đã kết thúc rõ.

Trước publish, kiểm ref/tree/worktree và artifact còn khớp checkpoint/evidence, sau đó push đúng SHA
đã lưu, không lấy HEAD mới nhất theo phỏng đoán. Git commit bất biến là căn cứ; khóa phối hợp không
được coi là đủ để ngăn mọi thay đổi từ bên ngoài. Có thay đổi thì giữ dữ liệu và chặn publish để đối
chiếu. Muốn đưa code mới vào PR phải gates, commit mới và review lại khi ở `full-review`; không commit
thêm file hoặc chạy formatter sau approval rồi dùng approval cũ. Ngoại lệ duy nhất là lượt sửa finding
minor ở [mục dưới](#finding-minor-sau-approve), với điều kiện phạm vi được Git trên host kiểm. Body đổi cần được reviewer đối chiếu
lại trong `full-review`; retry không dựng lại body khác cho cùng create intent.

## Review trên PR (quyết định 2026-11-04)

Reviewer chỉ trả kết quả có schema (verdict, summary, findings); daemon đăng lên PR, nên comment review
của cusr luôn khớp verdict mà engine dùng để rẽ nhánh. Worker và reviewer dùng được `gh` của owner để đọc
issue, PR và CI; việc họ tự làm trên GitHub không thay cho comment review hay việc push của daemon.

- `full-review` mở PR dạng draft. Mỗi lượt review được đăng thành một PR review `COMMENT` (không
  dùng `APPROVE`/`REQUEST_CHANGES`, vốn tác động lên điều kiện merge); review các vòng trước được giữ
  nguyên làm lịch sử. Mỗi lượt là đúng một comment: mọi finding (kèm file và dòng nếu có) nằm trong
  body, không tách thành inline comment theo từng file. `{{findings}}` chia hai nhóm `Blocking`
  (critical, major) và `Not blocking` (minor, info), mỗi nhóm xếp theo severity giảm dần, nhóm rỗng
  được bỏ.
- Verdict phải khớp findings: `request_changes` khi và chỉ khi còn ít nhất một finding critical hoặc
  major. Kết quả sai quy tắc này là output không hợp lệ.
- Comment đăng đúng lượt review mà bước review vừa dùng để rẽ nhánh, kể cả verdict được dùng lại; không
  lấy lượt review mới nhất của revision.
- Body có marker ẩn `<!-- cusr:review task=… attempt=… -->`. Daemon tìm marker trước khi đăng và
  sau một lần gửi mất trả lời. Kết quả gửi có ba trạng thái: `posted`, `not_posted` (chưa gửi hoặc
  GitHub từ chối hẳn với 4xx) và `unknown` (mất trả lời hoặc 5xx mà chưa thấy marker). Lượt review đã
  `posted` hoặc `unknown` không bao giờ được gửi lại, kể cả khi verdict được dùng lại; chỉ `not_posted`
  mới gửi lại. Văn bản của reviewer chứa marker điều khiển bị ẩn khỏi comment.
- Đăng review là bản ghi cho người đọc, không phải điều kiện của task: lỗi khi đăng được ghi trong kết
  quả effect và task đi tiếp.
- Approve thì daemon chuyển PR sang ready (GraphQL `markPullRequestReadyForReview`) rồi mới chờ CI.
  Chỉ chuyển khi PR vẫn nhắm target đã đóng băng và head vẫn là commit đã review. Target khác hoặc
  head khác thì giữ draft để bước CI ghi target_mismatch hoặc head_changed; PR đã đóng/merge cũng để
  bước CI xử lý.
- Repo muốn CI chỉ chạy sau approve cần bỏ qua PR draft và chạy lại khi `ready_for_review`. CI chạy
  cả trên draft cũng không sai, chỉ tốn lượt chạy. Daemon bỏ qua check run `skipped` kết thúc trước
  thời điểm PR chuyển ready (theo event `ready_for_review` của GitHub), để run bị skip lúc draft không
  được tính là đạt.
- Format comment theo `review_template` trong `cusr.yaml` (đường dẫn file trong repo, đọc từ frozen
  base); không khai báo thì dùng template mặc định. Placeholder: `{{round}}`, `{{verdict}}`,
  `{{summary}}`, `{{findings}}`, `{{inline_count}}` (luôn là `0`, giữ để template cũ vẫn hợp lệ),
  `{{head_sha}}`; chỉ thay chuỗi một lượt, không có điều kiện hay vòng lặp. Placeholder lạ, file
  thiếu hoặc marker `<!-- cusr:` trong template chặn task lúc start với
  `config_invalid:review_template`.
- Bước PR không giữ execution slot, nên review xếp hàng lấy lại slot sau khi PR mở; request
  `resumed` được ưu tiên hơn task mới ở cùng priority.

## Finding minor sau approve

Approve vẫn có thể kèm finding `minor` (lỗi thật, ảnh hưởng nhỏ) và `info` (chỉ để biết, không cần sửa).
Finding minor được sửa trước khi PR chuyển ready, không qua thêm một lượt reviewer. Finding minor không
bao giờ được chặn merge.

- Sau khi đăng review approve, nếu lượt review đó có finding `minor`, bước `fix_minor` gọi fixer đúng
  một lượt cho các finding đó. Chỉ có `info` hoặc không có finding thì bỏ qua cả nhánh này, PR chuyển
  ready như cũ. Mỗi lượt approve chỉ có một lượt sửa minor, kể cả khi lượt đó bị bỏ và verdict được
  dùng lại sau này (M03).
- Fixer nhận finding minor kèm phạm vi: chỉ đổi file có trong finding và test của chúng. Title và body
  PR mà fixer ghi không được nhận: PR giữ nội dung reviewer đã approve.
- Hết lượt agent, nấc model phải chờ duyệt hoặc bị cấm, hoặc binding ngoài bộ đã xác nhận thì không chạy
  fixer và không chờ người. Quá deadline cũng bỏ phần sửa minor; task sau đó chờ deadline như mọi task.
- Lượt fixer minor bị dừng bằng `pause --now` không chạy lại: phần sửa bị bỏ như khi fixer lỗi.
- Fixer không trả `done` (needs_input, needs_context, blocked), output không hợp lệ hoặc chạy lỗi (kể cả
  harness bị từ chối đăng nhập): không hỏi người, không retry. Daemon đưa worktree về checkpoint đã
  approve và PR chuyển ready với commit đó. Engine ghi tree của checkpoint đó là tree của task (T072):
  daemon không khôi phục được worktree thì lượt worker sau chờ người, phần sửa đã bỏ không vào commit.
- Bước `minor_gates` chạy cùng gate với bước `gates`. Gate đỏ hoặc tree không đứng yên thì cũng bỏ
  phần sửa như trên. Lượt gate bị bỏ không phải bằng chứng cho head, nên không làm head đã approve mất
  xanh.
- Gate đạt thì daemon commit checkpoint mới và ghi các file đổi từ commit đã approve (`changed_since`).
  Mọi file đổi đều là file có trong finding minor hoặc file test (thư mục `test/`, `tests/`,
  `__tests__/`, `spec/`; file `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.*`) thì engine ghi
  `MinorFixRecorded`: approval của lượt review đó áp dụng cho checkpoint mới. Checkpoint được publish,
  bước review thấy approval mang sang thì đi tiếp mà không gọi reviewer và không tính lượt review, rồi
  PR chuyển ready.
- Đổi file khác, hoặc daemon không đọc được diff, thì không mang approval sang: checkpoint mới đi qua
  publish và review như mọi thay đổi khác.
- Approval chỉ mang sang khi lượt review đó vẫn là verdict mới nhất của revision và head đúng là
  checkpoint của lượt sửa. Commit sau đó (sửa CI, tích hợp base có sửa code) cần review như thường.
  Tích hợp base chạy bước `gates` của task, không chạy `minor_gates`.

## Vòng review và sửa không tiến triển (#141)

- Signature của một lượt `request_changes` là tập file của các finding critical/major (không có thì
  của mọi finding), không tính câu chữ, số dòng hay finding minor/info. Lượt sau chặn lại trên đúng
  các file đó là cùng một lỗi dù reviewer viết khác.
- Gate xanh sau lượt sửa không xoá chuỗi lỗi review của fixer; chỉ approve mới xoá. Hai lượt review
  liên tiếp cùng signature nâng fixer lên rung kế tiếp như mọi lỗi chất lượng lặp lại; hết ladder thì
  chờ người.
- Kèm lượt `request_changes`, daemon ghi các file đổi từ commit mà lượt `request_changes` trước của
  cùng revision đã review (`changed_since`). Finding chặn nằm trên file lượt trước cũng chặn mà không
  commit nào đổi tới thì fixer đã bỏ qua nó: task chờ người với `review_repeated` (liệt kê file và
  finding) thay vì gọi fixer tiếp, vì model mạnh hơn không giải quyết được bất đồng về phạm vi. Câu
  trả lời đi tiếp như verdict thường: review được đăng rồi chuyển fixer. Daemon không đọc được diff
  thì bỏ kiểm này, không chặn task.
- Câu trả lời cho `review_repeated` là tín hiệu duy nhất đổi phạm vi mà engine nhận biết được, vì engine
  không đọc được nghĩa câu trả lời. Câu trả lời cho wait này bảo đảm fixer chạy ít nhất một lượt ở nấc
  hiện tại. Chuỗi lỗi của fixer đã xin nâng nấc thì câu trả lời cho đúng một lượt, ghi cùng transaction
  với câu trả lời (`AnswerTurnGranted`); lượt đó thất bại chất lượng, kể cả với signature mới, thì chuỗi
  lỗi lại xin nâng nấc như thường: còn nấc thì nâng, hết thang thì chờ. Chuỗi lỗi chưa xin nâng thì
  giữ nguyên các lượt thử còn lại theo luật thường; câu trả lời không cắt bớt. Sàn model, `max_visits`,
  budget và deadline vẫn áp dụng nên trả lời lặp lại dừng ở `loop_exhausted`.
- Fixer để nguyên toàn bộ đầu vào review (M03) thì lượt `request_changes` được dùng lại, không gọi
  reviewer, và task cũng chờ người với `review_repeated` thay vì gọi fixer tiếp, kể cả khi finding
  không có file hoặc chỉ ở mức minor/info. Đầu vào quay lại đúng bản từng bị từ chối cũng tính là
  không tiến triển. Lượt dùng lại vẫn tính vào chuỗi lỗi của fixer.
- Trước lượt review kế tiếp: gate của vòng sửa đã xanh và có checkpoint commit, daemon ghi các file
  đổi từ commit lượt `request_changes` gần nhất đã review tới checkpoint (`changed_since` của kết quả
  gate). Không file nào chứa finding chặn (major/critical, có file) bị đổi, ví dụ fixer chỉ nới test,
  thì task chờ người với `fix_no_src_change` (liệt kê file và finding) trước khi publish, không tốn một
  lượt reviewer. Câu trả lời cho qua gate như thường: publish rồi review. Chỉ cần một file của finding
  chặn bị đổi là đi tiếp; daemon không đọc được diff hoặc checkpoint trùng commit đã review (M03) thì
  bỏ kiểm này.
- Mỗi checkpoint ghi `base_conflicts`: base tip lấy từ `refs/remotes/origin/<base>` đã fetch cục bộ
  (không fetch thêm) và các file `git merge-tree` báo conflict khi tích hợp tip đó; không đọc được thì
  bỏ trống (unknown). Review từ chối một checkpoint đã publish có conflict với tip đó thì trước lượt
  fixer review, daemon tích hợp tip ấy bằng base update (SPEC.md §14.2, FR-041.04) thay vì để
  conflict tới lúc chờ merge. Conflict thì lượt fixer review là lượt fixer conflict duy nhất, nhận cả
  file conflict và finding; merge sạch thì gate, chứng nhận, rồi mới gọi fixer review. Head sau đó luôn
  qua review. Lượt fixer conflict không gỡ được mới chờ người (`refused`, trả lời `continue` hoặc
  `retry fixer`). Checkpoint không conflict hoặc unknown thì vòng sửa như thường.
- `cusr task explain` có `visits`: số lượt đã vào và giới hạn của từng step, gồm `review` và
  `fix_review`.

## Dùng lại kết quả review còn hiệu lực

Trong cùng task/revision, trước khi gọi reviewer, daemon MUST so đầu vào review với evidence đã lưu:
base dùng tính diff, checkpoint SHA/tree/diff digest, title/description cần review (không tính marker
điều khiển do orchestrator gắn), acceptance/conventions review đã đóng băng và policy/binding review.
Attempt ID, timestamp, receipt gate/CI mới, log resume hoặc summary worker tự báo (`worker_reports`) không tự
làm đổi đầu vào review: cùng code thì cùng verdict.
Chỉ dùng lại kết quả đã validate và ghi bền, còn hiệu lực, khi mọi đầu vào trên khớp;
không suy từ việc worker nói không sửa.
Trừ ngoại lệ tích hợp base bên dưới, code hoặc nội dung PR đổi thì review lại; acceptance/policy/base dùng tính diff đổi thì không được
dùng kết quả cũ. Base tip ngoài frozen base chỉ đổi không tự thay đầu vào, theo FR-041.04.
Chỉ việc worker chạy không tự vô hiệu evidence; phải đối chiếu tree/diff/body thực tế với checkpoint.

- Đã approve và đầu vào không đổi: dùng lại đúng evidence, không gọi reviewer khi retry publish,
  poll/rerun CI hoặc restart daemon. Gate/CI vẫn phải thỏa evidence và giới hạn riêng.
- Đã request changes và đầu vào không đổi: giữ findings cũ, xử lý lượt sửa không tiến triển theo
  failure signature/budget/escalation hiện có; không gọi reviewer để hỏi lại cùng một nội dung.
- Worker trả `done` mà tree code không đổi: giữ checkpoint SHA, không tạo commit mới chỉ vì step
  đã chạy. Nếu chỉ title/body đổi thì giữ commit nhưng xét lại review theo nội dung PR mới.

Không áp dụng cache qua task/revision khác và không chuyển approval sang SHA khác theo phỏng đoán.
Mất hoặc chưa rõ receipt của lượt review phải reconcile kết quả đã finalize trước khi quyết định
gọi lại; việc dùng lại evidence có provenance, không ghi một lượt reviewer/usage không thực sự xảy ra.

## Ngoại lệ review khi tích hợp base (quyết định 2026-11-02)

Áp dụng cả khi bật/tắt yolo; không đổi yêu cầu review ban đầu của `full-review`.
PR đang chờ merge tụt sau target được tích hợp qua execution slot và gate/publish/CI trên head mới.
Không conflict thì không gọi fixer/reviewer mới. Có conflict thì fixer sửa đúng một lượt; host so
với tree conflict và danh sách file do Git báo. Mỗi file conflict phải đổi so với tree conflict và qua gate thì miễn review mới; markerless no-op chưa đạt.
File ngoài phạm vi đổi (kể cả rename/file mới) phải review; `direct-pr` không có reviewer đóng băng
thì chờ người quyết định. Fixer lỗi/chưa xong, gate fail hoặc conflict lần sau mở question; answer `continue`
sau sửa tay tiếp tục gate/publish/CI, hoặc đúng `retry fixer` mới cấp thêm lượt worker. Markerless
no-op cần người xác nhận phiên bản đã chọn. Không tự retry fixer hoặc reset giới hạn.
Chứng nhận phạm vi gắn đúng head/tree/revision, có provenance trong `BaseUpdateRecorded`, không giả
reviewer approve hoặc dùng bằng chứng head cũ cho head mới. Xem [SPEC §14.2](../../SPEC.md#142-merge).
M03/M06 áp dụng ngoại lệ hẹp này; code/nội dung khác vẫn phải xét review theo quy tắc trên.
Base update bắt đầu trong vòng review/fix không được miễn review: lượt sửa mang cả thay đổi cho finding
mà reviewer chưa xem.

## Remote đổi head khi review còn chạy

Từ 2026-11-04, `full-review` push A và mở PR draft trước khi review; publish không còn đứng sau
approve. Các quy tắc dưới đây vẫn áp dụng, với "chuyển PR ready" và "đăng review" ở vị trí publish:
approve A không được chuyển PR có head B sang ready, và drift ghi trước khi kết quả review được
ingest thì không đăng review hay chuyển ready. Bảng H01–H06 giữ cách đánh số cũ để đối chiếu.

Reviewer đang kiểm commit A thì một bên khác có thể push B lên branch của task/PR. B ở đây là head
ngoài expected-old/new của operation hợp lệ, không phải kết quả push A đã được ghi intent nhưng chưa
ingest receipt. Khóa worktree không chặn được push từ bên ngoài; không lấy callback reviewer làm
bằng chứng remote vẫn khớp. Chỉ base tip đổi mà branch task không đổi vẫn theo FR-041.04.

- Khi đối chiếu thấy B ngoài dự kiến, ghi fact có expected/observed SHA và provenance, chuyển
  `WAITING/policy head_changed`, thu hồi xanh và chặn claim/dispatch nghiệp vụ mới, kể cả publish
  đã được enqueue nhưng chưa gửi. Không tự nhận B, chuyển approval sang B hoặc ghi đè remote.
- Reviewer trả approve A sau đó: vẫn đối chiếu và ghi receipt/result của đúng operation, có thể giữ
  làm lịch sử cho A, nhưng không gỡ blocker, không đổi expected/checked head và không route sang
  publish/CI/green cho B. Cùng quy tắc với findings hoặc receipt publish đến muộn; effect đã gửi
  phải được reconcile, không giả rằng request remote chưa xảy ra rồi gửi lại.
- Nếu approve A đến trước fact head_changed, nó chỉ đủ cho A. Trước publish phải đối chiếu lại
  identity/ref/remote SHA và blocker. Update remote phải giữ điều kiện expected-old tại lúc gửi
  đồng thời vẫn chỉ cho fast-forward; B chen giữa probe và push phải làm update bị từ chối, không
  force-push hoặc đổi expected-old theo remote mới. Không chứng minh được guard thì chờ đối chiếu.
- Restart giữ fact drift, blocker, binding của review với A và intent/receipt đang dở; replay hoặc
  ingest approve A không được mở lại đường publish. Chỉ luồng đối chiếu và lối ra đã quy định ở
  FR-029 mới có thể giải quyết head_changed; callback reviewer không phải lối ra.

Các scenario dưới đây là yêu cầu kiểm chứng, chưa phải test đã chạy:

| Mã | Thứ tự sự kiện | Kết quả bắt buộc |
| --- | --- | --- |
| H01 | Review A chạy → quan sát B → approve A | Giữ head_changed; lưu receipt A, không publish/nhận B hoặc báo xanh |
| H02 | Review A chạy → B được push → approve A enqueue publish → quan sát B trước dispatch | Pending publish không được claim/gửi; approve không gỡ blocker |
| H03 | Review A chạy → B được push → approve A → probe trước publish thấy B, chưa có poll mới | Probe chặn publish; không cần chờ observation timer phát hiện |
| H04 | Approve A → probe thấy expected-old → B chen trước update remote | Guard expected-old tại update từ chối push; B được giữ, không force hoặc nhận B |
| H05 | Restart giữa các bước H01–H03, kể cả approve đã finalize nhưng chưa ingest | Nhận lại receipt/fact, giữ blocker và SHA; không tạo commit/PR hoặc chạy lại reviewer chỉ vì restart |
| H06 | Review A chạy → chỉ base tip đổi, branch task và đầu vào review giữ nguyên → approve A | Không phát head_changed cho branch task hoặc gọi review lại chỉ vì base tip đổi |

H01–H03/H06 được kiểm bằng fake events/HTTP và integration của T050/T051/T053/T058/T139;
H04 bằng Git/bare remote thật tại T029/T041/T139; H05 có replay/SQLite ở T139, mở rộng crash I/O
tại T082/T093. Không coi test drift sau khi PR đã xanh là thay thế cho race callback đang review.

## Bằng chứng triển khai cần có

Các mã M dưới đây bổ sung coverage 117 nghĩa vụ FR hiện có; chưa có bằng chứng nghiệm thu.

| Mã | Kiểm chứng bắt buộc |
| --- | --- |
| M01 | Agent đề xuất từ chỉ dẫn; daemon không suy size/rủi ro; thiếu hoặc giả xác nhận không spawn |
| M02 | Xác nhận gắn đúng bộ lựa chọn; thay đổi/restart/replay/quota không bỏ qua xác nhận hoặc tự đổi chế độ; merge.method default/enum/freeze đúng, config mới không đổi task đang chạy |
| M03 | `direct-pr` không gọi reviewer; `full-review` cùng vendor, riêng session/chỉ đọc; reuse approve hoặc findings đúng đầu vào, no-op không gọi lại reviewer, đầu vào đổi buộc review mới |
| M04 | Gate/review/CI fail quay lại worker; cả resume và fallback nhận packet nguyên nhân sửa/trạng thái mới nhất, packet stale/thiếu bị chặn; fallback có lý do, không gọi chồng |
| M05 | Template frozen, lựa chọn nhiều template, artifact hợp lệ và được cập nhật sau fixer/CI; từ chối marker điều khiển giả trong title/body worker ở cả hai mode; không thêm writer agent |
| M06 | Gate/formatter sửa code buộc kiểm tập gate trên tree cuối trong giới hạn; mutation/writer hoặc remote drift H01–H04 chặn publish; approve A muộn không gỡ blocker/duyệt B, push đúng SHA đã kiểm |
| M07 | Commit/push/create/update PR timeout/crash nhận lại đúng intent/nội dung; replay H05 giữ drift và receipt A, không lặp commit/PR/reviewer; probe marker canonical cùng identity/receipt, không nhận PR giả hoặc ghi đè body ngoài dự kiến |
| M08 | Green/checked-head/explain thể hiện đúng mode; `direct-pr` không giả approve hoặc miễn CI/merge; 002 merge thủ công khác/unknown method vẫn hoàn tất khi proof/drain đạt, audit không giả phương thức hoặc làm head mất chứng nhận |
