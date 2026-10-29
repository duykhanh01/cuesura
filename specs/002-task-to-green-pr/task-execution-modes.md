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
| `full-review` | Code → gates → checkpoint commit → review → push → tạo/nhận lại PR → CI → chờ merge thủ công |

Trong `full-review`, yêu cầu sửa đi về worker → gates → commit nếu code đổi → xét evidence review
(dùng lại kết quả còn hiệu lực hoặc gọi reviewer theo điều kiện bên dưới). Trong
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
mới; quyền admin hiện có vẫn áp dụng cho escalation cần admin. Toàn bộ v1 không hỗ trợ đổi graph
của task đang chạy theo SPEC §5.3: đổi chế độ sau khi đã bắt đầu phải tạo task mới, không sửa FrozenPolicy.

Reviewer dùng session riêng, chỉ đọc; có thể cùng vendor/model với worker. Không có điều kiện
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

Orchestrator đọc PR template từ frozen base và đưa nguyên nội dung vào context worker. Nếu có
nhiều template, lựa chọn theo cấu hình tường minh; chưa chọn được thì chờ bổ sung. Không có template
thì worker viết mô tả thông thường; không suy đoán các heading bắt buộc.

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
Reviewer chỉ đọc checkout tương ứng; approval ghi cặp SHA và digest nội dung PR đã xem. Daemon giữ
khóa công việc worktree qua snapshot/review/publish và bảo đảm process có quyền ghi đã kết thúc rõ.

Trước publish, kiểm ref/tree/worktree và artifact còn khớp checkpoint/evidence, sau đó push đúng SHA
đã lưu, không lấy HEAD mới nhất theo phỏng đoán. Git commit bất biến là căn cứ; khóa phối hợp không
được coi là đủ để ngăn mọi thay đổi từ bên ngoài. Có thay đổi thì giữ dữ liệu và chặn publish để đối
chiếu. Muốn đưa code mới vào PR phải gates, commit mới và review lại khi ở `full-review`; không commit
thêm file hoặc chạy formatter sau approval rồi dùng approval cũ. Body đổi cần được reviewer đối chiếu
lại trong `full-review`; retry không dựng lại body khác cho cùng create intent.

## Dùng lại kết quả review còn hiệu lực

Trong cùng task/revision, trước khi gọi reviewer, daemon MUST so đầu vào review với evidence đã lưu:
base dùng tính diff, checkpoint SHA/tree/diff digest, title/description cần review (không tính marker
điều khiển do orchestrator gắn), acceptance/conventions review đã đóng băng và policy/binding review.
Attempt ID, timestamp, receipt gate/CI mới hoặc log resume không tự làm đổi đầu vào review.
Chỉ dùng lại kết quả đã validate và ghi bền, còn hiệu lực, khi mọi đầu vào trên khớp;
không suy từ việc worker nói không sửa.
Code hoặc nội dung PR đổi thì review lại; acceptance/policy/base dùng tính diff đổi thì không được
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

## Remote đổi head khi review còn chạy

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
