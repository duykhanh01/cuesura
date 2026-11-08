# Feature Specification: Luồng thực thi từ task tới PR xanh

**Feature Branch**: Không tạo branch; đặc tả nằm trong `specs/002-task-to-green-pr`.

**Created**: 2026-10-27

**Status**: Draft

**Cập nhật 2026-10-29**: [Chế độ thực thi và xác nhận trước khi chạy](task-execution-modes.md) bổ sung yêu cầu M01–M08: `direct-pr`/`full-review`, xác nhận bộ harness/model/effort trước spawn, worker chuẩn bị nội dung PR, commit trước review và ưu tiên resume worker khi sửa. Thiết kế chưa được triển khai; giữ nguyên bằng chứng spike/schema cũ.

**Input**: User description: "Viết spec feature 2 — chọn A: toàn bộ luồng tới PR xanh, gồm runner,
Claude/Codex, worktree, gate, review và GitHub."

## Bối cảnh và phạm vi

Feature 002 lấy mốc **Luồng xuyên suốt** của [SPEC.md §19](../../SPEC.md) làm kết quả chính, nối
[lõi điều phối tất định](../001-deterministic-core/spec.md) với các thao tác thực tế. Chủ dự án giao một
task có acceptance, xác nhận cấu hình chạy, theo dõi agent trong worktree riêng, nhận PR đã qua gate, CI và review theo chế độ,
và biết rõ khi nào hệ thống cần mình can thiệp. Phạm vi chủ đích rộng hơn một hàng của roadmap:
recovery, 200 lần ngắt daemon, inbox, CLI và health lấy một phần từ mốc **Khôi phục và tương tác**;
smoke thật hai chiều vendor lấy bằng chứng liên quan từ R8. Giữ chúng trong feature 002 để nghiệm thu
luồng thực thi sử dụng được; không coi đây là một walking skeleton nhỏ hoặc toàn bộ v1.

Phạm vi gồm daemon thực thi, runner độc lập, harness giả lập và hai harness Claude Code/Codex CLI,
chuẩn bị worktree/context, setup/gate, vòng sửa theo review/CI, commit/push/tạo hoặc nhận lại PR,
CLI tối thiểu để giao task và xử lý câu hỏi, cùng recovery cho các effect được feature này thực thi.
Chỉ chạy workflow phát triển phần mềm mặc định, chế độ quyết định `human`, tối đa một task thực thi
tại một thời điểm. “Task thực thi” là task đang giữ slot cho attempt hoặc bước Prepare/setup/gate/
autofix/publish; không phải mọi task đã bắt đầu mà chưa kết thúc. Task chỉ chờ CI, người, merge hoặc
cooldown trả slot khi process/effect thực thi đã rõ kết quả. Theo dõi chỉ đọc không chiếm slot này.
Coder, fixer và reviewer là các role được thực thi trong feature này.

**Bàn giao và hoàn tất:** [PR xanh](../../GLOSSARY.md) gắn với một head SHA cụ thể, gate/review và
danh sách CI bắt buộc đã đối chiếu; không bảo đảm head đã cập nhật theo base mới nhất. Task chờ người
dùng tự merge trên GitHub, được quan sát tới khi task kết thúc hoặc hết hạn quan sát. Head đổi làm thu hồi xanh
và chờ người, không tự sửa/ghi đè; base tip đổi không tự kích hoạt xử lý trong feature này. Khi xác
nhận PR đã merge vào branch đích, hệ thống ghi bền bằng chứng và chặn công việc nghiệp vụ mới;
chỉ chuyển DONE sau khi process thuộc task đã dừng và các effect đã gửi có kết quả rõ ràng (FR-040).
Head khác head đã kiểm được đánh dấu `merged_head_unverified`, không chứng nhận chất lượng head đã merge;
**không chuyển DONE chỉ vì PR xanh**. Hệ thống không gửi merge và không cấp quyền yolo.

Ngoài phạm vi: thực thi merge và hàng đợi merge, nhận task từ GitHub issue/comment, Telegram, đồng bộ thông báo
đa kênh, scheduler nhiều task song song, group/epic, decider, scout/refiner, workflow tùy ý,
backup/restore/migration vận hành đầy đủ, dashboard, amend-policy, kiểm lại/chấp nhận head mới và
`cusr task retry`. Muốn làm lại, người dùng
dùng `task add`; retry có liên kết nguồn dành cho feature sau. Tự cập nhật/rebase branch khi base
đổi thuộc phần merge, ngoài phạm vi feature 002. Cấu hình yêu cầu năng lực chưa hỗ trợ phải bị
chặn trước thực thi, không âm thầm bỏ bước. Đây là một mốc triển khai của v1, chưa phải bản phát hành v1.

**Thứ tự giao bắt buộc trong cùng feature:**

0. Spike ngày 1 trước khi xây lát 1: sandbox host và sandbox lồng nhau của hai harness, auth trong
   home riêng, schema ba role × hai vendor, network và fixture GitHub head-at-merge. Đây là thử
   nghiệm cô lập có giới hạn usage, không phải luồng xuyên suốt; phải đạt trước khi xây runtime A.
1. Luồng tới PR xanh, vòng sửa và quyền/bằng chứng với harness giả lập: US1, US2, US4 theo số story
   hiện tại (US4 là US5 trong bản trước khi sắp lại ưu tiên).
2. Recovery/chống trùng với đủ 200 lần ngắt và replay, inbox/hủy, CLI/health: US3, US5, US6 hiện tại
   (US5 là US4 trong bản trước). Chứng minh nhận lại runner và không nhân đôi publish trước smoke thật.
3. Smoke thật với cả hai chiều vendor và hai hệ sinh thái, gồm restart và merge thủ công: SC-001,
   SC-002, SC-005, SC-008. Chưa đạt lát trước thì chưa nghiệm thu/chạy luồng harness thật xuyên suốt.

Lõi 001 hiện hoàn tất sau kết quả effect merge do hệ thống yêu cầu; chỉ chặn dispatch merge sẽ làm
task kẹt. Feature 002 MUST bổ sung đường quyết định nhận bằng chứng merge bên ngoài và hoàn tất tại
FR-040, có kiểm tra hồi quy, không giả lập approval hoặc thành công của một lệnh merge chưa hề gửi.
Quyết định và các phương án đã loại được ghi tại
[ADR-0001](../../docs/adr/0001-observe-manual-merge.md).

**Môi trường đã chốt:** Luồng tự động mặc định **Isolated**: rootless bwrap bọc toàn bộ harness và
repo-controlled setup/gate/autofix, runner trong systemd user unit theo
[ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md). V1 chỉ có một backend bwrap qua port
`SandboxProvider` nhỏ; Native-only và Container/VM chưa triển khai. Không bắt buộc AppArmor 4,
Ubuntu 24.04 hay child stack Cuesura; host có restriction userns cần provisioning phù hợp bởi quản
trị viên theo [runbook](../../deploy/README.md), giữ policy/sysctl host. systemd user manager là
prerequisite runner, gồm kiểm WSL2 thực sự bật systemd. Mặc định setup/gate/autofix/agent được dùng
Internet ra ngoài; không có egress allowlist và không hứa chặn LAN/loopback, nhưng filesystem/PID và
credential điều phối vẫn cách ly. Lát 0 kiểm cấu hình này trước triển khai.
Lát 0 vẫn thử sandbox nội bộ bật; đây không phải chế độ Native-only. Nếu nesting fail, chỉ cho mode
`external_verified` theo ngoại lệ có điều kiện ADR-0004 sau khi outer boundary và
permission/approval được kiểm chứng, owner cho phép tường minh; không `--dangerously-*` hoặc bypass quyền.

## Clarifications

### Session 2026-11-08 — giữ chỗ và cho mượn slot khi chờ bên ngoài (issue #206), thay phần còn lại của Q3

- Task rời RUNNING để chờ CI, merge, người hoặc cooldown giữ slot của nó thành chỗ giữ, không trả. Chờ vì
  pause, deadline, hủy hoặc đang dọn sau merge thì vẫn trả slot như trước.
- Chỗ giữ cho mượn được: một task READY chưa từng chạy, không phụ thuộc task giữ chỗ và không làm trên PR
  của nó, được chạy trên chỗ mượn. Mỗi chỗ giữ cho một task mượn tại một thời điểm và số task mượn không
  quá `runtime.concurrency`, nên số task chạy cùng lúc không quá 2N. Task đã bắt đầu không mượn và task
  đang mượn không giữ chỗ hay cho mượn tiếp; chờ bên ngoài thì nó trả chỗ mượn.
- Task giữ chỗ quay lại thì chạy ngay trên slot của nó, không xếp hàng và không ngắt task mượn. Task mượn
  làm nốt việc đang chạy, tới việc cần slot kế tiếp (Prepare/setup, agent, gate, publish) thì trả chỗ
  mượn và chờ WAITING/policy `execution_slot` như task đã bắt đầu.
- Task giữ chỗ chỉ lấy lại chỗ khi chạy việc cần slot. Việc chỉ đọc hay ghi GitHub (poll CI, tạo PR, mark
  ready) không lấy lại chỗ, không đặt lại hạn và không làm chỗ mượn kết thúc. Chỗ mượn gắn với đúng lượt
  giữ chỗ đã cho mượn: task giữ chỗ đã lấy lại rồi giữ chỗ lần nữa thì chỗ mượn cũ vẫn kết thúc.
- Chỗ giữ hết hạn sau `runtime.slot_reservation_hours` (mặc định 24) tính từ lúc bắt đầu giữ. Hết hạn thì
  slot thành slot trống, cấp theo FR-044.03; task mất chỗ quay lại phải xếp hàng theo priority. Task
  đang mượn chỗ đó cũng trả ở việc cần slot kế tiếp như trên.

### Session 2026-11-07 — slot theo task (issue #206), thay một phần Q3

- Slot gắn với task, không gắn với loại bước. Task đang RUNNING giữ slot qua mọi bước và effect tự động,
  kể cả effect không chạy process (tạo PR, review, fix_review…); không nhả ở ranh giới bước. Trước đây
  slot bị nhả giữa `publish → pr → review` và task phải xếp hàng lại sau task priority thấp hơn (#203).
- Số task giữ slot cùng lúc là `runtime.concurrency` trong config user, mặc định 1, đọc khi cusrd khởi
  động. Thứ tự cấp vẫn theo FR-044.03.
- Phần còn lại của Q3 giữ nguyên trong mốc này: task rời RUNNING để chờ CI/merge/người/cooldown vẫn trả
  slot. Giữ chỗ và cho mượn khi chờ bên ngoài là việc tiếp theo của issue #206.

### Session 2026-11-02 — thay thế Q5/Q12 và quy tắc subset của FR-042

- Required checks là hợp snapshot và mọi tên check GitHub đang bắt buộc, kể cả check ngoài policy/ghim
  app, áp dụng cả khi yolo bật/tắt. Tên/app được lưu trong CI evidence; snapshot giữ nguyên.
- Không có check bắt buộc: observation vẫn vào chờ merge; riêng yolo không merge và log hướng dẫn
  khai `ci.required_checks`, không fallback sang mọi check trên head.
- Merge tự kiểm tra đúng app được pin và compare `head...target` có `ahead_by === 0`; giữ replay
  schema/event/wait mismatch cũ. Chi tiết hiện hành ở FR-042 và SPEC.md §14.2.

### Session 2026-10-27

- Q: Feature 2 bao gồm toàn bộ luồng tới PR xanh hay chỉ runner/harness? → A: Toàn bộ luồng tới PR xanh
  (phương án A), theo mốc kế tiếp trong SPEC.md §19.
- Q1: Chờ merge kết thúc thế nào? → A: Theo dõi PR; merge thủ công được xác nhận thì DONE kèm
  merge commit; head khác head đã kiểm theo Q9. Không gửi merge, không giả lập approval (FR-040).
- Q2: PR xanh là snapshot hay được theo dõi? → A: Bằng chứng gắn một head SHA, được quan sát tới khi
  task kết thúc hoặc hết hạn quan sát theo Q11; head đổi thì thu hồi xanh/chờ người, PR đóng chưa merge thì chờ, base tip đổi không
  tự xử lý trong feature 002 (FR-041/043, glossary).
- Q3: Slot giữ trong lúc chờ không? → A: Không; slot chỉ cho công việc đang thực thi, worktree vẫn
  giữ. Task cần sửa tiếp phải xếp hàng xin slot (FR-044, glossary). Đã thay bằng Session 2026-11-07 và
  2026-11-08: slot theo task, giữ chỗ và cho mượn khi chờ bên ngoài.
- Q4: Kiểm tra cấu hình ở đâu? → A: Chốt base revision, kiểm tra và đóng băng snapshot trước
  READY → RUNNING; lỗi thì PENDING với chẩn đoán, chưa worktree. Thứ tự là snapshot → RUNNING →
  tạo worktree (FR-002).
- Q5: Nguồn required checks? → A: `ci.required_checks` đóng băng trong `cusr.yaml`, đối chiếu với
  branch protection/rulesets GitHub; yêu cầu GitHub phải nằm gọn trong snapshot theo Q12,
  nếu không thì chờ người, không tự lấy hợp/thay snapshot. Không đọc được là
  unknown, không coi là khớp (FR-042).
- Q6: Giữ hay tách feature? → A: Giữ một feature gộp hai mốc, giao fake trước, recovery/tương tác
  tiếp theo, smoke thật cuối cùng theo thứ tự bên trên.
- Q7: Replay projection? → A: Sau mỗi lần ngắt phải dựng lại từ event log và khớp 100% (SC-004).
- Q8: Có `task retry` không? → A: Cố ý ngoài phạm vi; dùng `task add` để giao lại, retry liên kết
  nguồn thuộc feature sau (FR-045).
- Q9: PR merge ở head khác head đã kiểm thì task kết thúc ra sao? → A: DONE kèm
  `merged_head_unverified`; bằng chứng ghi head đã merge, head Cuesura đã kiểm và tuyên bố không
  chứng nhận chất lượng head đã merge. DONE xác nhận merge theo S01 (FR-040).
- Q10: Chấp nhận trạng thái chờ chỉ còn merge thủ công hoặc cancel? → A: Có cho feature 002;
  FR-029 liệt kê lối ra từng detail và CLI explain in đúng các lối ra đó. Kiểm lại head mới và
  amend-policy thuộc feature sau, không mở thêm lượt/thời hạn.
- Q11: Theo dõi PR tới terminal có vi phạm I07? → A: Dùng backoff tới trần và thời hạn quan sát
  tổng hữu hạn; hết hạn chuyển WAITING/policy với `observation_expired`, ngừng tự poll. Chỉ recheck
  mới đối chiếu lại, thấy merge vẫn DONE; plan chốt giá trị cụ thể (FR-043/046).
- Q12: Repo không có branch protection xử lý thế nào? → A: GitHub yêu cầu là tập con của snapshot
  thì đối chiếu đạt; có check ngoài snapshot thì `required_checks_mismatch`. GitHub xác nhận không
  có quy tắc thì ghi `github_required: none`; không đọc được vẫn unknown. Sửa chi tiết Q5 (FR-042).
- Q13: Cùng priority, task đang dở có ưu tiên hơn task mới? → A: Có; WAITING/policy với
  `execution_slot` đứng trước READY. Trong cùng nhóm xếp theo thời điểm xin slot, không theo lúc
  tạo task; không ngắt task đang chạy (FR-044).
- Q14: PENDING vì cấu hình được thử lại khi nào? → A: Chỉ khi task confirm hoặc recheck có dedup,
  đọc lại base mới nhất; không tự theo dõi base. Giữ needs_info, thêm detail `config_invalid` /
  `capability_missing` (FR-002/046).
- Q15: Thấy merge khi attempt/effect còn chạy thì xử lý thế nào? → A: Ghi bền merge và chặn effect
  nghiệp vụ mới, dùng cơ chế dừng/đối chiếu của cancel nhưng không tạo yêu cầu hủy giả. Chỉ DONE khi
  process đã dừng và effect đã gửi rõ kết quả; push đã gửi có thể vẫn thành công, phải ghi nhận thực
  tế. Giữ diff/commit local chưa publish trong worktree, không gửi push mới; restart tiếp tục việc
  dừng/đối chiếu. Hết giới hạn đối chiếu thì chờ merge_cleanup_pending, có recheck hữu hạn (FR-040/046).
- Q16: DONE kèm merged_head_unverified có giải phóng dependency? → A: Có, nhưng chỉ sau khi ghi
  DONE theo Q15. Điều kiện dependency là hoàn tất, không phải chứng nhận chất lượng; task phụ thuộc
  vẫn qua kiểm tra riêng, explain hiển thị prerequisite chưa chứng nhận và dẫn tới bằng chứng (FR-001/027).
- Q17: Thời gian chờ slot có tính vào deadline? → A: Có từ khi workflow chạy lần đầu theo SPEC.md
  §9.4; READY chờ slot lần đầu chưa tính, chờ xin lại slot sau khi đã chạy có tính. Explain tách
  thời gian chờ slot; Q13 chỉ ưu tiên việc dở cùng priority, không bảo đảm chống đói slot (FR-043/044).
- Q18: Có ghi ADR về quan sát merge thủ công và DONE chưa chứng nhận? → A: Có, tại
  [ADR-0001](../../docs/adr/0001-observe-manual-merge.md), một đoạn gồm bối cảnh, quyết định, lý do và
  phương án đã loại; tự merge hoãn sang feature sau, cancel-only không phản ánh đúng kết quả merge.

### Session 2026-10-28

- Q19: Mạng mặc định cho setup/gate/autofix và agent thế nào? → A: Cho Internet outbound để dùng
  registry/vendor; giữ cách ly filesystem và không cấp credential điều phối. Feature 002 chưa có
  domain allowlist hoặc cam kết chặn LAN/loopback; snapshot ghi rõ network mode.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Giao task và nhận PR đủ bằng chứng để duyệt (Priority: P1)

Chủ dự án giao task cho repo được phép. Hệ thống chốt yêu cầu và cấu hình, tạo môi trường riêng, gọi
coder, chạy gate, gọi reviewer, rồi công bố PR và theo dõi CI. Người dùng xem được PR, trạng thái,
lý do chờ và các bằng chứng mà không phải tự điều phối từng bước.

**Why this priority**: Đây là kết quả sử dụng được đầu tiên của sản phẩm, nối lõi đã có với công việc thật.

**Independent Test**: Giao một task nhỏ trên repo sandbox có gate và required checks đã cấu hình;
kiểm tra bằng chứng từng bước, PR duy nhất và trạng thái chờ merge. Có thể kiểm tra luồng này bằng
harness giả lập trước khi chạy smoke với harness thật.

**Acceptance Scenarios**:

1. **Given** task hợp lệ, đủ quyền và ngân sách, **When** giao task và mọi bước đạt, **Then** hệ thống
   tạo đúng một worktree/branch của task, chạy Code → Gates → Review → Publish → CI và hiển thị PR
   xanh cùng head SHA; task chờ duyệt merge, chưa DONE và không có request merge.
2. **Given** task thiếu acceptance, chưa xác nhận hoặc dependency chưa DONE, **When** nhận task,
   **Then** task ở PENDING với lý do và cách xử lý; chưa tạo worktree, chưa gọi agent.
3. **Given** cấu hình project không hợp lệ, **When** kiểm tra lại base/cấu hình trước READY → RUNNING,
   **Then** task giữ/trở lại PENDING/needs_info với config_invalid, chưa tạo worktree.
   Nếu lỗi khả năng thực thi được phát hiện sau khi đã RUNNING, task chuyển WAITING/policy, không
   về PENDING. Agent sửa cấu hình sau khi chốt snapshot không làm đổi gate của task đó.
4. **Given** gửi lại yêu cầu tạo task có cùng request ID và nội dung, **When** daemon xử lý,
   **Then** trả cùng task; cùng ID nhưng khác nội dung trả conflict và không tạo task thứ hai.
5. **Given** profile yêu cầu scout, decider hoặc workflow chưa hỗ trợ, **When** kiểm tra trước chuyển
   RUNNING, **Then** task ở PENDING/needs_info với capability_missing và cách sửa input/profile; không tự
   thay workflow/role. Nếu chỉ phát hiện sau RUNNING thì WAITING/policy theo scenario 3.
6. **Given** người dùng đã merge PR (head trùng hoặc khác head đã kiểm), **When** poll, recovery hoặc recheck xác nhận
   repo/PR/branch đích, head đã merge và merge commit, **Then** lưu bằng chứng ngay và hoàn tất việc
   dừng/đối chiếu theo FR-040 trước khi ghi DONE đúng một lần và giải phóng dependency;
   không có request merge từ Cuesura. Kết quả lặp không tạo
   hoàn tất lần hai. Merge head khác vẫn DONE với merged_head_unverified, hai head và tuyên bố
   không chứng nhận chất lượng head đã merge; thiếu bằng chứng thì chờ đối chiếu, không tự DONE.
7. **Given** task A chỉ chờ CI/merge và đã trả slot, **When** task B bắt đầu thực thi rồi CI của A fail,
   **Then** A chờ policy với chi tiết execution_slot, không chiếm slot của B; sau B trả slot, A được
   xét theo priority, rồi task đã bắt đầu trước READY cùng priority, rồi thời điểm xin slot trong
   cùng nhóm. Task READY priority cao hơn vẫn đứng trước A; không có hai task thực thi đồng thời.
8. **Given** task PENDING/needs_info vì config_invalid hoặc capability_missing và base đã được sửa,
   **When** chưa có lệnh người dùng, **Then** không tự thử lại; task confirm hoặc recheck mới đọc
   base mới nhất, kiểm tra lại/chốt snapshot theo FR-002. Request trùng không chốt/cấp việc hai lần;
   cấu hình còn lỗi thì giữ PENDING với detail tương ứng, chưa worktree/agent.
9. **Given** fixer hoặc effect push của task còn chạy khi PR được merge, **When** hệ thống xác nhận
   merge, **Then** ghi bền bằng chứng, chặn effect nghiệp vụ mới và vô hiệu effect chưa dispatch,
   dừng process thuộc task, đối chiếu effect đã gửi; chưa DONE hoặc trả slot khi công việc còn chưa
   rõ. Push đã gửi có thể thành công sau merge và được ghi nhận, không retry publish; diff/commit
   local còn lại được giữ cùng bằng chứng, không gửi push mới. Chỉ DONE khi dừng/đối chiếu xong.
10. **Given** B phụ thuộc A và A đã được xác nhận merge chưa chứng nhận, **When** A còn dừng/đối
    chiếu, **Then** B vẫn chờ dependency; sau khi A ghi DONE với merged_head_unverified, điều kiện
    dependency được thỏa. B chỉ READY/chạy khi các điều kiện riêng đạt; explain của B hiển thị A
    chưa chứng nhận và dẫn tới bằng chứng merge của A, không yêu cầu approval bổ sung chỉ vì dấu này.
11. **Given** task mới chờ slot ở READY và task đã chạy đang xin lại slot, **When** thời gian trôi
    qua, **Then** chỉ task đã chạy bị tiêu thời hạn toàn task; tới hạn thì task_deadline và không
    được cấp công việc nghiệp vụ mới. Explain tách thời gian chờ slot; restart không reset deadline
    hay mất thời gian chờ đã ghi, ưu tiên Q13 không được mô tả là bảo đảm không đói slot.

---

### User Story 2 - Sửa lỗi theo gate, review và CI trong giới hạn (Priority: P1)

Chủ dự án nhận thay đổi đã được kiểm tra. Khi kiểm tra thất bại, agent nhận đúng lỗi và sửa trong giới
hạn đã cho phép; hệ thống không coi lời agent báo xong là đủ và không dùng kết quả cũ cho code mới.

**Why this priority**: PR chỉ hữu ích khi có bằng chứng chất lượng và vòng sửa không tiêu tốn vô hạn.

**Independent Test**: Dùng các task mẫu lần lượt gây gate fail, review request_changes và CI fail do
code; kiểm tra vòng sửa, bằng chứng mới và số lượt. Tách mẫu lỗi hạ tầng để kiểm tra không nâng model.

**Acceptance Scenarios**:

1. **Given** coder trả kết quả hợp lệ nhưng gate fail, **When** xử lý kết quả, **Then** không publish;
   fixer nhận log lỗi có giới hạn và acceptance; sửa xong phải chạy lại gate trước review.
2. **Given** reviewer yêu cầu sửa, **When** fixer đổi code, **Then** kết quả review cũ mất hiệu lực;
   gate, checkpoint commit và review chạy lại trước publish trong `full-review`. Reviewer dùng session
   riêng, chỉ đọc, có thể cùng vendor/model; thiếu binding/quota thì chờ hoặc xin xác nhận lựa chọn khác.
3. **Given** PR có CI fail do code, **When** còn lượt sửa, **Then** sửa trên worktree của task, chạy
   lại gate/review cần thiết và cập nhật chính PR đó; CI của head cũ không làm head mới thành xanh.
4. **Given** CI lỗi hạ tầng hoặc flaky có bằng chứng phân loại, **When** policy cho phép thử lại,
   **Then** chỉ thử lại trong giới hạn, không nâng model vì lỗi này. Lỗi chưa phân loại được làm task
   chờ có lý do, không tự coi là lỗi code.
5. **Given** đã hết lượt, thời hạn, ngân sách hoặc thiếu approval cho nấc tiếp, **When** cần gọi agent,
   **Then** không bắt đầu attempt; task chờ quyết định, hiển thị giới hạn đã chạm và cách kết thúc.
6. **Given** GitHub yêu cầu A/B và CI rules đã đóng băng yêu cầu B/C, **When** xác định PR xanh,
   **Then** chờ hợp A/B/C trên đúng head; cả ba success và gate/review hợp lệ thì xanh, không sửa snapshot.
   Ghi tên và app của yêu cầu GitHub vào evidence. Không đọc đủ GitHub thì unknown và chờ infra.
   Nếu GitHub chỉ yêu cầu B hoặc xác nhận không có quy tắc, vẫn cần B/C pass.

7. **Given** PR đang xanh và chờ merge, **When** head hoặc tập required checks thay đổi,
   **Then** head do người ngoài đẩy làm thu hồi xanh/chờ policy để người quyết định, không tự sửa
   hoặc ghi đè remote; GitHub yêu cầu check không được snapshot bao phủ làm thu hồi xanh/chờ policy. Nếu chỉ base
   tip đổi, giữ bằng chứng cho head đó, ghi nhận thông tin quan sát, không tự cập nhật base, gọi fixer,
   chạy lại kiểm tra hay đổi trạng thái chỉ vì base tip đổi. Không tuyên bố đủ điều kiện merge.
8. **Given** PR đã xanh, **When** check bị chạy lại hoặc PR đóng mà chưa merge,
   **Then** check pending/fail thu hồi xanh và đi qua CI/vòng sửa; PR đóng thì chờ policy với chi tiết
   pr_closed, không DONE, không tạo PR khác; vẫn quan sát trong hạn FR-043. Nếu PR mở lại khi còn hạn,
   tự đối chiếu lại đúng head/tập checks trước khi tiếp tục trong giới hạn thực thi; hết hạn cần recheck.
9. **Given** CI không đạt trong thời gian chờ hoặc số lần kiểm tra CI tự động được cấp,
   **When** chạm giới hạn, **Then** task WAITING/ci với ci_wait_exhausted, không tự sửa/rerun/gia hạn.
   Quan sát trạng thái PR vẫn tiếp tục trong hạn FR-043, không giữ slot hay gọi agent. CI pass muộn
   được ghi làm bằng chứng nhưng không tự mở lại ngân sách thực thi; merge được xác nhận vẫn DONE
   theo FR-040, kể cả khác head đã kiểm.
10. **Given** task đang chờ người merge, **When** deadline thực thi hết, **Then** WAITING/policy với
    task_deadline và không mở attempt mới; vẫn quan sát PR tự động trong hạn FR-043. Merge sau đó
    làm DONE theo FR-040 khi được xác nhận; hết hạn quan sát cần recheck, không tăng deadline.
11. **Given** PR chưa terminal và quan sát tự động đã hết hạn tổng, **When** đến hạn kể cả qua restart,
    **Then** WAITING/policy với observation_expired, không còn poll tự động; backoff trước đó không
    vượt trần. Recheck đối chiếu một lần: thấy merge thì DONE theo FR-040, chưa merge hoặc unknown
    thì vẫn ngừng poll, giữ lý do/giới hạn đang chặn và bằng chứng mới; không gia hạn quan sát/thực thi.

---

### User Story 3 - Tiếp tục an toàn sau khi daemon bị dừng (Priority: P1)

Chủ dự án có thể khởi động lại daemon mà không mất công việc, gọi thêm agent cho cùng attempt hay tạo
PR trùng. Khi không biết một thao tác đã xảy ra hay chưa, hệ thống nói rõ và đối chiếu trước khi làm tiếp.

**Why this priority**: Không lặp thao tác và không mất dữ liệu là điều kiện của mọi thực thi thật.

**Independent Test**: Ngắt daemon tại các điểm trước/sau khởi chạy agent, commit, push và tạo PR;
khởi động lại rồi so sánh process, lịch sử, worktree, remote branch và PR với lần chạy không bị ngắt.

**Acceptance Scenarios**:

1. **Given** agent còn chạy khi daemon chết, kể cả khi chưa kịp ghi nhận danh tính process,
   **When** daemon khởi động lại, **Then** nhận lại attempt đó trước khi cấp việc mới; không tạo
   runner/harness thứ hai và không trả giữ chỗ ngân sách khi chưa rõ đã chạy hay chưa.
2. **Given** agent đã kết thúc khi daemon không chạy, **When** khôi phục, **Then** kết quả hợp lệ và
   phần output chưa xử lý được ghi nhận một lần về mặt logic; không chạy lại agent chỉ để lấy kết quả.
3. **Given** commit, push hoặc tạo PR đã thành công nhưng chưa lưu xác nhận, **When** khôi phục,
   **Then** đối chiếu để nhận lại đúng thành quả; không tạo commit/PR trùng, không force-push và không
   reset worktree vì HEAD khác checkpoint.
4. **Given** process identity không khớp hoặc đối chiếu remote lỗi mạng, **When** khôi phục,
   **Then** giữ trạng thái chưa rõ và chờ xử lý; không giết process không thuộc task, không phát lại
   thao tác nguy hiểm. Attempt được chứng minh đã chết nhưng thiếu kết quả được ghi là lost.
5. **Given** kho trạng thái không ghi được hoặc một daemon khác đang giữ quyền ghi, **When** định cấp
   việc, **Then** không phát effect mới; báo health lỗi, không tuyên bố trạng thái đã được lưu.
6. **Given** trạng thái được khôi phục sau mỗi lần ngắt daemon, **When** dựng lại projection từ nhật
   ký đã commit, **Then** projection khớp 100% trạng thái lưu, kể cả slot, kết quả ingest và timer;
   không cấp việc khi còn khác biệt hoặc claim chưa đối chiếu xong.
7. **Given** bằng chứng merge đã ghi bền nhưng việc dừng/đối chiếu chưa xong, **When** daemon restart
   hoặc nhận kết quả fixer/push đến muộn, **Then** tiếp tục dừng/đối chiếu với giới hạn còn lại,
   không resume fixer, publish lại hay giải phóng dependency sớm. Hết giới hạn mà còn unknown thì
   WAITING/policy với merge_cleanup_pending và phần chưa rõ; recheck thực hiện một lượt hữu hạn,
   chỉ DONE sau khi đủ bằng chứng dừng process và kết quả các effect.

---

### User Story 4 - Chạy agent đúng quyền và đọc được bằng chứng (Priority: P1)

Chủ dự án biết agent nào đã chạy, dùng quyền/model nào, đã tạo thay đổi gì và tiêu tốn bao nhiêu lượt.
Reviewer không được sửa repo; log và context không làm lộ secret điều phối.

**Why this priority**: Việc thực thi thật chỉ được phép khi quyền và kết quả kiểm chứng được.

**Independent Test**: Chạy cùng bộ tình huống coder/fixer/reviewer với từng harness, gồm output hợp lệ,
sai/cắt cụt, refusal, usage thiếu, ghi ngoài phạm vi và chạy yên lặng nhưng còn tiến triển.

**Acceptance Scenarios**:

1. **Given** hai harness đã kiểm chứng khả năng cần thiết, **When** chạy từng role được hỗ trợ,
   **Then** kết quả được chuẩn hóa và gắn provenance của đúng attempt; lịch sử có harness/model/version,
   quyền, thời điểm, usage và artifact. Usage thiếu được ghi unavailable, không thay bằng 0.
2. **Given** exit thành công nhưng output sai cấu trúc, cắt cụt, sai ngữ nghĩa hoặc chỉ có artifact cũ,
   **When** nhận kết quả, **Then** không coi là done/approve; áp giới hạn xử lý invalid output của policy.
3. **Given** reviewer chỉ đọc hoặc coder bị giới hạn vùng ghi, **When** khởi chạy,
   **Then** quyền hiệu lực khớp policy; phát hiện thay đổi ngoài vùng phép thì dừng để đối chiếu.
   Môi trường không chứng minh được giới hạn cần thiết bị chặn trước thực thi tự động liên quan.
4. **Given** agent không xuất log nhưng process con còn làm việc, **When** kiểm tra stall,
   **Then** không coi im lặng là mất tiến triển; khi thật sự hết timeout/stall, dừng đúng cây process
   trong thời gian hữu hạn và không giết process dùng chung ngoài task.
5. **Given** context/log chứa secret thử nghiệm hoặc vượt giới hạn dung lượng, **When** thu thập và
   hiển thị, **Then** secret bị che trước khi lưu/xuất, phần bị rút gọn được báo rõ; output chưa ingest
   không bị bỏ âm thầm và context không thiếu acceptance bắt buộc mà vẫn được gửi như đầy đủ.
6. **Given** profile yêu cầu quyền hoặc trần chi phí cứng mà harness chưa có bằng chứng hỗ trợ,
   **When** kiểm tra trước chạy, **Then** chặn attempt và chỉ rõ khả năng thiếu; không thay cam kết
   bằng ước lượng chi phí hoặc việc có worktree riêng.

---

### User Story 5 - Trả lời câu hỏi và hủy công việc có kiểm soát (Priority: P2)

Người dùng thấy câu hỏi trong inbox, trả lời để agent tiếp tục, hoặc yêu cầu hủy mà vẫn giữ thay đổi
đã làm. Agent không cần sống chỉ để chờ câu trả lời, CI hay hạn mức.

**Why this priority**: Luồng thực tế phải có đường xử lý khi thiếu thông tin hoặc không thể tiếp tục.

**Independent Test**: Cho harness trả needs_input, gửi câu trả lời hai lần, rồi thử hủy một attempt có
process con và một task có publish chưa rõ kết quả.

**Acceptance Scenarios**:

1. **Given** agent hỏi người dùng, **When** attempt kết thúc, **Then** câu hỏi được lưu và hiện trong
   inbox, task chờ human_input và không có agent đang chạy chỉ để chờ; restart không làm mất câu hỏi.
2. **Given** câu hỏi thuộc revision hiện tại, **When** người có quyền trả lời, **Then** câu trả lời hợp
   lệ đầu tiên được ghi nhận và đưa vào context của lần tiếp tục; request lặp trả kết quả cũ, câu trả
   lời cạnh tranh hoặc sai revision bị từ chối, không tạo thêm attempt.
3. **Given** task có attempt đang chạy và effect chưa dispatch, **When** hủy, **Then** chặn effect
   nghiệp vụ mới, dừng cây process thuộc attempt trong giới hạn và bảo toàn diff; chỉ ghi CANCELLED
   khi các thao tác đã gửi có kết quả rõ ràng.
4. **Given** hủy khi kết quả publish chưa rõ, **When** đối chiếu thấy PR đã tạo, **Then** ghi lại PR và
   kết quả thực tế trước khi hoàn tất hủy; không tự đóng PR, xóa branch hay giả vờ chưa publish.
5. **Given** agent hết hạn mức hoặc bị từ chối quyền/auth, **When** xử lý, **Then** task chờ có lý do;
   cooldown có lịch kiểm tra lại hữu hạn, lỗi auth chờ người, refusal không bị retry/escalate để vượt qua.
6. **Given** người dùng yêu cầu hủy task có PR, **When** đối chiếu mới xác nhận PR đã merge vào branch
   đích trước khi hoàn tất hủy, **Then** hoàn tất dừng/đối chiếu rồi ghi DONE với merge commit và
   “yêu cầu hủy đến quá muộn”,
   không CANCELLED; khác head đã kiểm ghi merged_head_unverified theo FR-040. Không đọc được kết quả
   merge thì vẫn chờ đối chiếu; không suy ra chưa merge.
7. **Given** agent trả needs_context/blocked hoặc session cũ không còn dùng được khi nhận câu trả lời,
   **When** quyết định tiếp tục, **Then** ghi phần thiếu/đường xử lý; chỉ gọi attempt mới với Q&A đầy
   đủ khi đủ quyền, slot và ngân sách; không tự gọi role ngoài phạm vi.

---

### User Story 6 - Xem và điều khiển luồng qua CLI (Priority: P2)

Chủ dự án hoặc assistant được cấp quyền dùng CLI để tạo, xem, giải thích và hủy task, trả lời câu hỏi
và duyệt nấc escalation. Trạng thái thông thường được dựng từ dữ liệu đã ghi, không cần gọi LLM.

**Why this priority**: Luồng xuyên suốt phải dùng và kiểm tra được mà không sửa trực tiếp kho trạng thái.

**Independent Test**: Chạy các thao tác ở dạng người đọc và dạng máy đọc, gồm daemon mất kết nối,
request lặp, thiếu quyền, đối tượng không tồn tại và version cũ.

**Acceptance Scenarios**:

1. **Given** task đang chạy hoặc chờ, **When** xem/giải thích task, **Then** thấy bước hiện tại, lý do,
   PR/head nếu có, lượt đã dùng/giữ chỗ, bằng chứng và hành động tiếp theo; không có lời gọi LLM mới.
   Thời gian chờ slot được tách riêng; prerequisite DONE chưa chứng nhận hiện cùng liên kết bằng
   chứng, kể cả sau khi task phụ thuộc đã bắt đầu. Merge đã xác nhận nhưng còn dừng/đối chiếu hiện
   riêng với DONE, kèm process/effect chưa rõ và cách xử lý.
2. **Given** một lệnh hữu hạn ở chế độ máy đọc, **When** thành công hoặc lỗi xử lý được,
   **Then** có đúng một kết quả có version, mã lỗi ổn định và exit code theo SPEC.md §15.1; log không
   trộn vào kết quả. Xem log liên tục có vị trí nối lại để không mất/trùng bản ghi đã xác nhận.
3. **Given** caller chỉ có quyền đọc hoặc tự khai tên chủ dự án, **When** gửi thao tác thay đổi/duyệt,
   **Then** dịch vụ từ chối; agent không thể tự duyệt escalation hay lấy secret quản trị qua CLI.
4. **Given** một yêu cầu approve merge/yolo, **When** gửi vào phiên bản này, **Then** báo chưa hỗ trợ,
   không ghi nhận quyền merge và không dispatch merge; hướng dẫn chủ dự án merge trên GitHub rồi
   theo dõi hoặc recheck để ghi nhận DONE.
5. **Given** người dùng muốn làm lại task terminal, **When** gọi task retry, **Then** CLI báo chức
   năng chưa hỗ trợ và không tạo task; hướng dẫn dùng task add. Task add tạo yêu cầu độc lập qua
   triage/xác nhận/policy, không mở lại task cũ hoặc tự thêm liên kết retry.
6. **Given** task đang được quan sát, **When** người có quyền gọi task recheck, **Then** thực hiện một lần
   đối chiếu PR/CI có timeout, lưu bằng chứng và cập nhật trạng thái; không gửi merge, gọi agent hoặc
   reset ngân sách/deadline. Request lặp được dedup; không tạo thêm chuỗi quan sát song song.
   Sau observation_expired chỉ đối chiếu lần này, không khởi động lại poll; task PENDING lỗi cấu
   hình/năng lực thì đọc base mới nhất và thử chốt snapshot theo FR-002. Task terminal không mở lại.
   Nếu merge đã được xác nhận nhưng còn merge_cleanup_pending, recheck yêu cầu một lượt dừng/đối
   chiếu hữu hạn theo FR-040, không tiếp tục workflow hoặc retry publish.
7. **Given** task chờ với từng detail trong FR-029, **When** gọi task explain, **Then** in đúng lối ra
   còn khả dụng và giới hạn đã hết; không gợi ý amend-policy, kiểm lại head mới hoặc mở thêm lượt.

### Edge Cases

- **EC-001**: Task thứ hai đủ điều kiện khi slot thực thi đang được giữ: chờ cấp việc; restart khôi phục slot
  trước. Task chưa chạy giữ READY; task đã chạy cần sửa tiếp thì WAITING/policy với execution_slot.
  Task chỉ chờ người/CI/merge/cooldown không giữ slot; effect/process chưa rõ kết quả vẫn giữ claim.
  READY chờ slot lần đầu chưa tính deadline; chờ xin lại slot sau khi workflow đã chạy vẫn tính.
- **EC-002**: Worktree/branch đã tồn tại, mất hoặc có thay đổi chưa bảo toàn: đối chiếu ownership/checkpoint;
  chỉ phục hồi khi đủ bằng chứng, không ghi đè hoặc xóa để thử lại.
- **EC-003**: Setup/gate/autofix có side effect và daemon chết trước khi lưu kết quả: chỉ chạy lại nếu hợp đồng
  cho phép; nếu không, chờ người với phần đã làm được bảo toàn.
- **EC-004**: Output bị cắt giữa bản ghi, log rotation, disk full, kho tạm bận: không mất dấu ingest đã xác nhận,
  không coi kết quả chưa ghi bền là thành công.
- **EC-005**: Reboot, máy sleep, đồng hồ đổi và PID được tái sử dụng: không gia hạn deadline, nhận nhầm process
  hay tiêu thụ timer hai lần về mặt logic.
- **EC-006**: Required check missing/pending/cancelled/unknown hoặc không lấy đủ danh sách: không báo PR xanh.
  GitHub yêu cầu ngoài snapshot thì chờ người; snapshot có thêm check vẫn hợp lệ và phải pass đủ.
  GitHub xác nhận không có quy tắc được ghi github_required: none, khác unknown.
  Head đổi làm CI/review cũ mất hiệu lực cho head mới;
  chỉ base tip đổi không thu hồi bằng chứng theo head và không kích hoạt cập nhật base/merge.
- **EC-007**: Remote branch bị người khác cập nhật hoặc PR trùng marker: thu hồi xanh, đối chiếu và chờ khi mơ hồ,
  không tạo PR thay thế hay ghi đè remote. PR đóng chưa merge chờ policy; PR merge
  vào branch đích thì DONE sau khi dừng/đối chiếu xong theo FR-040, kể cả khi đang xử lý hủy; head khác head đã kiểm ghi
  merged_head_unverified, không chứng nhận chất lượng head đã merge. Merge commit có thể khác head
  đã merge do squash/rebase; cần chứng cứ head của PR tại merge, không so hai commit này bằng nhau.
- **EC-008**: Task đã terminal không tự mở lại vì sự kiện remote đến sau. Merge thực sự xảy ra sau khi CANCELLED
  được ghi bền là hành động bên ngoài vòng đời task; lịch sử đối chiếu ghi sự thật nhưng không sửa
  terminal. Điều này khác với merge đã xảy ra khi yêu cầu hủy còn đang được xử lý.
- **EC-009**: Source drift được ghi nhận trong lúc chạy: cho attempt hiện tại kết thúc, chặn bước nghiệp vụ kế
  tiếp, giữ diff và chờ quyết định ở ranh giới an toàn; không dùng chứng cứ revision cũ cho revision mới.
- **EC-010**: Merge trong lúc fixer/setup/gate/publish còn chạy: ghi nhận merge không đồng nghĩa đã
  dừng process hoặc thu hồi push đã gửi. Giữ claim khi chưa rõ, lưu cả kết quả đến muộn và diff/commit
  local chưa publish; không tự push phần còn lại, xóa worktree hoặc bỏ bằng chứng merge sau restart.

## Requirements *(mandatory)*

### Functional Requirements

Mã FR gốc giữ ổn định để dẫn chiếu nhóm. Với nhóm đã tách, mỗi mã con (ví dụ `FR-040.01`) là
một nghĩa vụ nghiệm thu riêng; plan/tasks và báo cáo kiểm chứng phải dùng mã con. Dẫn chiếu mã
nhóm bao gồm toàn bộ các mục con, không thay thế việc kiểm chứng từng mục.

**Nhận task và chuẩn bị thực thi**

- **FR-001**: Nhận task và dependency. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-001.01** | Intake MUST kiểm tra acceptance, dependency, quyền, workflow/profile và request dedup trước khi chạy theo feature 001; người có quyền được giao, xác nhận và đọc kết quả task trong repo được phép. |
  | **FR-001.02** | Dependency MUST được coi là thỏa khi prerequisite đã ghi DONE, kể cả merged_head_unverified, không thêm approval vì dấu này; task phụ thuộc vẫn qua các điều kiện riêng. |
  | **FR-001.03** | Dependency MUST NOT được giải phóng chỉ vì thấy merge khi prerequisite còn dừng/đối chiếu; bằng chứng chưa chứng nhận hiển thị theo FR-027.04. |

- **FR-002**: Kiểm tra cấu hình và chốt snapshot. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-002.01** | Hệ thống MUST lấy base revision thực tế, kiểm tra cấu hình/năng lực và chốt đồng thời policy/context trong xử lý tín hiệu bắt đầu, theo thứ tự snapshot → RUNNING → tạo worktree. |
  | **FR-002.02** | Lỗi cấu hình/năng lực trước RUNNING MUST giữ/trả PENDING/needs_info với config_invalid/capability_missing tương ứng, kèm chẩn đoán và cách sửa; chưa tạo worktree. |
  | **FR-002.03** | Sau lỗi này, hệ thống MUST chỉ thử lại qua task confirm/recheck có dedup, đọc base mới nhất và kiểm tra/chốt snapshot; vẫn qua acceptance/dependency/quyền, không tự poll cấu hình hoặc base tip. |
  | **FR-002.04** | Lỗi policy/năng lực phát hiện sau RUNNING MUST chuyển WAITING/policy, không về PENDING; lỗi hạ tầng theo FR-015. |
  | **FR-002.05** | Hệ thống MUST NOT bỏ role/bước hoặc đổi binding để vượt kiểm tra cấu hình/năng lực. |
  | **FR-002.06** | Base branch khác nhánh mặc định của repo mà là head của một PR đang mở (chưa merge) MUST bị preflight chặn thành config_invalid với check `stacked_base`, nêu PR đó, task sở hữu nếu nhánh là `cusr/<task-id>-…`, và các lối ra: merge PR đó trước, làm tiếp PR bằng `task add --pr` (adopt), hoặc tạo lại task trên base của PR. Chỉ owner chọn stack có chủ đích bằng label `stacked-base` trên task do chính owner tạo; label trên task assistant tạo không có hiệu lực (issue #167). |

- **FR-003**: Mỗi task thực thi MUST có một worktree và branch riêng do orchestrator sở hữu. MUST
  kiểm tra repo/cwd/vùng ghi và ownership trước khi dùng; bảo toàn repo gốc, diff chưa commit và commit
  chưa push. Worktree đã tồn tại/mất MUST được đối chiếu trước khi nhận lại/phục hồi.
- **FR-004**: Setup, gate và autofix MUST dùng cấu hình đã đóng băng, có giới hạn thời gian và hợp đồng
  chạy lại. MUST ghi checkpoint trước bước có thể ghi và lưu kết quả của lệnh; sau kết quả chưa rõ,
  lệnh không chứng minh được chạy lại an toàn MUST chờ người.
- **FR-005**: Context mỗi role MUST có yêu cầu/acceptance bất biến, dữ liệu cần cho bước và provenance;
  fixer có lỗi liên quan, reviewer có diff hiện tại. MUST giới hạn kích thước, báo phần rút gọn, loại
  secret/cú pháp quản trị kênh và giữ dữ liệu tạm ngoài thay đổi được commit. Không đủ context bắt buộc
  MUST hỏi/chờ thay vì âm thầm cắt rồi chạy.

**Điều phối và runner**

- **FR-006**: Daemon MUST là bên duy nhất ghi trạng thái và chỉ dispatch effect sau khi ý định thực
  thi được ghi bền. Việc giữ/trả slot tuân theo FR-044, khôi phục trước cấp việc theo FR-036.
- **FR-007**: Runner MUST có vòng đời độc lập với daemon và quản lý toàn bộ cây process của attempt.
  Khởi chạy/retry cùng thao tác MUST không tạo attempt trùng, kể cả daemon chết trước khi lưu danh
  tính process. Khả năng nhận lại MUST kiểm chứng cả khi daemon chạy foreground và dưới service manager.
- **FR-008**: Mỗi attempt MUST lưu invocation đã che secret, danh tính process đủ chống nhận nhầm sau
  reboot/PID reuse, output, liveness/progress, kết thúc và kết quả chuẩn theo hợp đồng SPEC.md §12.
- **FR-009**: Hệ thống MUST phân biệt còn sống với còn tiến triển; im lặng không tự là stall. Timeout,
  stall và cancel MUST dừng process thuộc attempt trong thời hạn hữu hạn, xác nhận không còn process
  ngoài ý muốn và không dừng process không thuộc task. Sleep/restart/đổi đồng hồ MUST không reset hạn mức.
- **FR-010**: Trước mỗi lời gọi agent, hệ thống MUST kiểm tra role/binding/quyền/approval, slot và ngân
  sách đã resolve. MUST phân biệt lượt giữ chỗ với đã dùng; chỉ trả giữ chỗ khi chắc chắn chưa gọi.
  Repair, resume và lời gọi bị rate limit đều tính là đã dùng khi đã thực sự xảy ra.

**Harness, chất lượng và quyền**

- **FR-011**: Hệ thống MUST hỗ trợ harness giả lập, Claude Code và Codex CLI cho coder/fixer/reviewer.
  Mỗi harness MUST có bằng chứng phiên bản, khả năng quyền/giới hạn thực tế và khả năng nhận/trả kết
  quả của từng role. Không đáp ứng quyền hoặc trần chi phí cứng được yêu cầu MUST bị từ chối trước chạy.
- **FR-012**: Kết quả MUST được kiểm tra cấu trúc, ngữ nghĩa và provenance của attempt hiện hành trước
  khi dùng. Exit thành công, lời báo xong hoặc artifact cũ MUST NOT đủ để qua bước. Nguồn kết quả và
  fallback MUST theo SPEC.md §12.3; metadata do orchestrator gắn, không tin ID agent tự khai.
- **FR-013**: Coder/fixer MUST chỉ ghi trong vùng được cấp; reviewer MUST chỉ đọc. Phát hiện thay đổi
  ngoài phạm vi MUST dừng để đối chiếu; không tự gán thay đổi của người dùng ở repo gốc cho agent.
- **FR-014**: Gate bắt buộc MUST đạt trước review/publish. Trong `full-review`, reviewer MUST dùng
  session riêng, chỉ đọc; approval MUST gắn base SHA/commit SHA cố định sau checkpoint và nội dung PR
  đã xem. Không ràng buộc khác vendor/model. Trong mode này, code đổi MUST vô hiệu bằng chứng liên quan,
  chạy lại gate, commit và review. `direct-pr` MUST bỏ reviewer theo chế độ đã được người dùng xác nhận, không giả
  approve hoặc suy skip từ size; publish cả hai mode MUST khớp checkpoint. Gate/formatter sửa code MUST
  kiểm lại tập gate bắt buộc trên tree cuối trong giới hạn retry an toàn. Trong cùng task/revision,
  approve/findings còn hiệu lực và mọi đầu vào review không đổi MUST được dùng lại, không gọi reviewer
  hoặc tạo commit mới chỉ vì worker no-op; đầu vào đổi MUST xét review mới theo M03/M06, trừ chứng nhận phạm vi tích hợp base theo SPEC.md §14.2. Xem M01–M08.
- **FR-015**: Mọi thất bại MUST được phân loại theo SPEC.md §9.2 và áp đúng giới hạn kế thừa từ feature
  001: infra tối đa 3 retry; timeout/stall tối đa 1 retry; invalid output tối đa 1 repair và 1 session
  mới mỗi nấc trước khi xét nâng; auth/refusal chờ người. Rate limit/infra MUST không nâng model vì
  chất lượng; unknown MUST chờ đối chiếu. Trần tổng lượt/thời gian luôn có ưu tiên khi chạm trước.
- **FR-016**: Mọi attempt MUST ghi binding thực tế, phiên bản harness, thời gian, outcome, usage và
  artifact tra cứu được; usage MUST phân biệt reported/estimated/unavailable, không ghi 0 thay dữ
  liệu thiếu. Secret MUST được che trước khi lưu/xuất; log/context có giới hạn và chính sách lưu giữ.

**Publish và CI**

- **FR-017**: Orchestrator MUST tạo branch/worktree, checkpoint commit trước review (nếu có),
  push đúng SHA đã kiểm và tạo hoặc nhận lại PR trên repo/head/base đúng của task. Worker MUST chuẩn
  bị commit message và PR title/description theo template frozen; artifact được validate trước dùng.
  Mỗi thao tác logic MUST có idempotency key ổn định và bằng chứng đủ đối chiếu sau
  timeout/crash. Agent MUST không được cấp quyền tự publish hoặc merge thay orchestrator.
- **FR-018**: Trước khi thử lại commit/push/tạo PR, hệ thống MUST đối chiếu theo SPEC.md §13.2. Remote
  khác SHA dự kiến hoặc nhiều kết quả mơ hồ MUST được báo để xử lý, không force-push, tạo PR thay thế
  hoặc reset worktree theo phỏng đoán. PR đã merge được xử lý theo FR-040, PR đóng chưa merge theo
  FR-041. Đối chiếu thiếu bằng chứng MUST giữ unknown.
- **FR-019**: Vòng chờ CI để tự động tiếp tục thực thi MUST có giới hạn; quan sát PR vẫn tiếp tục
  theo FR-043. Hệ thống MUST chỉ báo PR xanh khi có danh sách required checks
  đầy đủ, mọi check thành công cho đúng head hiện tại, gate đạt và review còn hiệu lực nếu là
  `full-review`; `direct-pr` MUST hiện rõ không chạy review. Pending,
  cancelled, missing, unknown hoặc danh sách chưa xác định đầy đủ MUST không được coi là pass.
  Nguồn danh sách theo FR-042; giới hạn và hành vi khi hết hạn theo FR-043; thu hồi xanh theo FR-041.
- **FR-020**: CI fail do code MUST đi qua vòng sửa có giới hạn, gate/review cần thiết rồi cập nhật cùng
  PR. CI infra/flaky chỉ rerun khi phân loại có bằng chứng và policy cho phép; autofix chỉ chạy theo
  cấu hình đóng băng/hợp đồng chạy lại. Mỗi lần head đổi MUST chờ bằng chứng CI mới.
- **FR-021**: Khi PR xanh, task MUST ở WAITING/approval với chi tiết merge, hướng dẫn merge thủ công,
  PR/head/base, tập checks và thời điểm kiểm tra cuối. MUST không dispatch merge ở mọi chế độ, kể cả
  yolo đã cấu hình; yêu cầu cấp quyền merge/yolo bị từ chối là chưa hỗ trợ. Chỉ bằng chứng merge thực
  tế theo FR-040 mới làm DONE; tiếp tục quan sát trong hạn theo FR-041/043.

**Recovery và tương tác**

- **FR-022**: Startup MUST giành quyền ghi độc quyền và kiểm tra tương thích/toàn vẹn trạng thái trước
  dispatch; không đạt thì báo health lỗi và chặn cấp việc. Các bước recovery riêng tại FR-034–036.
- **FR-023**: Khi kho không ghi được, hệ thống MUST dừng phát effect mới, báo health lỗi và giữ dữ liệu
  cần phục hồi; không báo thành công/chờ đã lưu nếu chưa ghi bền. Kết quả từ runner còn sống MUST được
  giữ để ingest sau; không xóa dữ liệu chưa bảo toàn nhằm giải phóng chỗ.
- **FR-024**: Needs_input MUST kết thúc attempt, lưu question bền và đưa task về WAITING/human_input;
  inbox vẫn hiển thị câu hỏi sau restart. Trả lời và tiếp tục theo FR-037–039.
- **FR-025**: Hủy task và đối chiếu kết quả. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-025.01** | Cancel MUST chặn effect nghiệp vụ mới và vô hiệu effect chưa dispatch. |
  | **FR-025.02** | Cancel MUST dừng process thuộc task trong giới hạn theo FR-009. |
  | **FR-025.03** | Cancel MUST đối chiếu effect đã gửi và trạng thái PR mới nhất trước khi kết thúc; chưa rõ merge thì tiếp tục chờ đối chiếu. |
  | **FR-025.04** | Nếu merge được xác nhận, cancel MUST kết thúc DONE theo FR-040 kèm “yêu cầu hủy đến quá muộn”, kể cả merged_head_unverified; chỉ CANCELLED khi PR chưa merge và các effect đã rõ. |
  | **FR-025.05** | Cancel MUST bảo toàn diff/commit/PR đã tạo; không tự đóng PR, xóa branch hoặc hoàn tác thao tác bên ngoài. |

- **FR-026**: Source drift và revision MUST giữ ngữ nghĩa feature 001: ghi drift ngay, cho attempt hiện
  tại kết thúc, chặn bước nghiệp vụ tiếp theo đến ranh giới an toàn; áp revision mới không reset lượt,
  nấc hay deadline và không dùng bằng chứng cũ. Feature này không thêm kênh intake cập nhật nguồn;
  executor MUST tôn trọng drift/revision khi được lõi ghi nhận.
- **FR-027**: CLI và explain. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-027.01** | CLI MUST hỗ trợ task add/show/list/explain/history/logs/confirm/cancel/recheck, inbox/answer và approve cho escalation. |
  | **FR-027.02** | Hệ thống MUST cung cấp kiểm tra môi trường và health phục vụ luồng này; thông tin trạng thái thông thường dựng bằng code, không gọi LLM. |
  | **FR-027.03** | Explain MUST tách thời gian chờ slot và chỉ rõ deadline chưa bắt đầu hoặc thời hạn còn lại. |
  | **FR-027.04** | Explain MUST hiển thị prerequisite DONE có merged_head_unverified và liên kết bằng chứng, kể cả khi task phụ thuộc đã chạy. |
  | **FR-027.05** | Với merge_cleanup_pending, explain MUST hiển thị merge đã xác nhận, process/effect chưa rõ, giới hạn dừng/đối chiếu và thao tác recheck; không mô tả task đã DONE. |
  | **FR-027.06** | Explain MUST cho thấy phạm vi nhánh của task còn sống: file nhánh đã đổi so với base, task còn sống khác cùng project đổi chung file, số commit base nhánh còn thiếu và file sẽ xung đột khi tích hợp base tip (đọc bằng `git merge-tree`). Task list MUST cho thấy với mỗi task: task đổi chung file, file xung đột với base và việc phạm vi chưa đọc được. Dữ liệu chỉ đọc repo cục bộ (ref base đã fetch gần nhất), không fetch, không gọi GitHub hay LLM, trong một hạn thời gian chung ngắn hơn timeout của CLI; phần đọc không được hoặc quá hạn MUST hiện là unknown, phân biệt với "không có", và không làm hỏng truy vấn (issue #210). |

- **FR-028**: CLI và dịch vụ MUST giữ hợp đồng quyền read/operate/admin, request dedup/version/conflict,
  output máy đọc và exit code của SPEC.md §15.1–15.2. Quyền MUST kiểm tra tại dịch vụ bằng nguồn đáng
  tin cậy; tên người gửi, marker process hoặc việc có terminal MUST không tự chứng minh quyền.
- **FR-029**: Mọi task chờ MUST có lý do, điều kiện tiếp tục và đường kết thúc đọc được. CLI explain
  MUST in đúng các lối ra dưới đây theo detail và các giới hạn còn hiệu lực; recheck không bỏ qua
  blocker khác. Quan sát tự động chỉ còn trong hạn FR-043; sau observation_expired cần recheck.
  Cleanup MUST không xóa dữ liệu chưa bảo toàn; tự dọn worktree đang chờ merge ngoài phạm vi.

  | Reason / detail | Lối ra trong feature 002 |
  | --- | --- |
  | approval / merge | Merge thủ công vào branch đích → quan sát/recheck → DONE theo FR-040; hoặc cancel. |
  | policy / task_deadline; ci / ci_wait_exhausted; hết thang/lượt/ngân sách | Không mở thêm lượt/gia hạn; có PR thì merge thủ công → xác nhận → DONE, hoặc cancel. Chưa có PR thì chỉ cancel; muốn làm lại dùng task add độc lập. |
  | policy / head_changed | Người dùng trả branch về head đã kiểm → đối chiếu lại trong giới hạn; hoặc merge thủ công → DONE theo FR-040; đóng PR → pr_closed; hoặc cancel. Không có lệnh kiểm lại/chấp nhận head mới. |
  | policy / target_mismatch | Trước merge: đổi base về branch đích trong snapshot → đối chiếu lại, hoặc cancel. Merge sai branch không đủ bằng chứng DONE vào đích yêu cầu. |
  | policy / required_checks_mismatch | Wait lịch sử vẫn replay được; lượt quan sát sau đối chiếu theo hợp tên mới và tự đi tiếp, hoặc ci_wait_exhausted nếu cửa sổ CI đã hết. Không sửa snapshot tại chỗ; merge thủ công/cancel vẫn hợp lệ. |
  | policy / pr_closed | Mở lại PR → đối chiếu lại trong giới hạn; hoặc cancel. Đóng PR chưa phải terminal. |
  | policy / observation_expired | Recheck hữu hạn để cập nhật bằng chứng; xác nhận merge thì DONE theo FR-040. Chưa merge thì merge thủ công rồi recheck, hoặc cancel; không tự bật lại poll/gia hạn. |
  | policy / merge_cleanup_pending | Hoàn tất dừng/đối chiếu trong giới hạn → DONE; hết giới hạn thì người dùng xử lý phần chưa rõ được explain chỉ ra rồi recheck một lượt hữu hạn. Cancel không bỏ qua đối chiếu hoặc đổi merge đã xác nhận thành CANCELLED; không tiếp tục workflow/publish. |
  | policy / execution_slot | Đợi cấp slot theo FR-044 nếu còn đủ điều kiện; hoặc cancel. |
  | PENDING needs_info / config_invalid, capability_missing | Sửa cấu hình/năng lực rồi task confirm hoặc recheck đọc base mới nhất; hoặc cancel. Không tự thử lại. |
  | human_input; needs_context/blocked | Trả lời/bổ sung phần thiếu qua tương tác được hỗ trợ theo FR-037–039, hoặc cancel; không tự gọi role ngoài phạm vi. |
  | approval / escalation | Duyệt đúng phạm vi khi còn ngân sách, hoặc cancel; approval không mở thêm lượt đã hết. |
  | infra / unknown, auth; cooldown | Khắc phục kết nối/quyền hoặc đợi cooldown hữu hạn rồi đối chiếu lại trong giới hạn; hoặc cancel sau khi effect/merge đã rõ. Lỗi đọc không chứng minh chưa merge. |

  Amend-policy và kiểm lại/chấp nhận head mới thuộc feature sau. Lối ra merge luôn phải thỏa
  repo/PR/branch đích và bằng chứng FR-040; lối ra cancel phải thỏa đối chiếu FR-025.

**Yêu cầu tách riêng về artifact, quyền và recovery**

- **FR-030**: Kết quả/artifact hoàn chỉnh MUST chỉ được công bố sau khi đã lưu đầy đủ; trạng thái ghi
  một phần không được đọc như kết quả hoàn chỉnh.
- **FR-031**: Output MUST được ingest đúng một lần về mặt logic qua restart; dòng cuối rách phải chờ
  đủ dữ liệu khi attempt còn chạy, log rotation không được bỏ phần chưa ingest hoặc làm lặp dữ liệu
  đã ghi nhận. Attempt đã kết thúc mà kết quả vẫn cắt cụt phải được phân loại invalid output, không
  chờ thêm dữ liệu vô hạn.
- **FR-032**: Secret và quyền quản trị MUST ở ngoài tầm agent; agent không được dùng danh tính chủ dự
  án hoặc CLI để tự cấp quyền/approval.
- **FR-033**: Kiểm tra môi trường MUST chặn chế độ tự động khi chưa chứng minh được giới hạn quyền
  cần thiết. Có worktree riêng không tự đủ làm bằng chứng cách ly.
- **FR-034**: Recovery attempt/effect. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-034.01** | Recovery MUST đối chiếu từng attempt/effect còn mở và nhận lại process/kết quả phù hợp trước khi tiếp tục; chưa chứng minh attempt cũ kết thúc thì không spawn thay thế. |
  | **FR-034.02** | Sau merge đã ghi bền, recovery MUST tiếp tục dừng/đối chiếu theo FR-040.09, giữ chặn nghiệp vụ và không resume workflow. |
  | **FR-034.03** | Kết quả đến muộn sau xác nhận merge MUST chỉ bổ sung bằng chứng, không kích hoạt fixer/push. |

- **FR-035**: Attempt chắc chắn chết mà thiếu kết quả MUST được ghi lost; chỉ resume tối đa một lần
  khi policy/session cho phép. Recovery không reset diff, lượt, nấc hoặc deadline.
- **FR-036**: Recovery MUST khôi phục slot/khóa worktree/timer, kiểm tra projection dựng lại khớp dữ
  liệu đã commit và ghi báo cáo trước cấp việc mới; còn claim chưa rõ hoặc projection lệch thì chặn
  cấp việc, giữ bằng chứng và báo health lỗi.
- **FR-037**: Trả lời inbox MUST kiểm tra quyền/revision, chấp nhận câu trả lời hợp lệ đầu tiên;
  request lặp trả kết quả cũ, câu trả lời cạnh tranh trả conflict.
- **FR-038**: Sau trả lời, resume MUST chỉ dùng cùng harness với session hợp lệ và policy cho phép;
  nếu không, attempt mới nhận Q&A đã ghi, vẫn qua kiểm tra slot/ngân sách/quyền.
- **FR-039**: Needs_context/blocked MUST ghi phần thiếu và đường xử lý cho người dùng, không coi là
  done hoặc tự gọi role ngoài phạm vi.

**Vòng đời PR và cấp slot**

- **FR-040**: Hoàn tất sau merge thủ công. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-040.01** | Với task chưa terminal, hệ thống MUST ghi bền bằng chứng đáng tin cậy về merge đúng repo/PR/branch đích, head tại merge và merge commit cùng việc chặn nghiệp vụ mới, vô hiệu effect chưa dispatch. |
  | **FR-040.02** | Sau xác nhận merge, hệ thống MUST dừng mọi process thực thi thuộc task theo cơ chế FR-025; không tạo cancel giả hoặc ghi “hủy đến quá muộn” nếu không có yêu cầu hủy. |
  | **FR-040.03** | Hệ thống MUST đối chiếu mọi effect đã gửi và ghi kết quả đến muộn; push đã gửi có thể thành công sau merge/ghi nhận merge, không hứa thu hồi request. |
  | **FR-040.04** | Hệ thống MUST ghi DONE đúng một lần và giải phóng dependency chỉ sau khi process đã được xác nhận dừng và mọi effect đã gửi rõ kết quả; chưa đủ thì WAITING/policy với merge_cleanup_pending, giữ claim theo FR-044 và hiển thị sự thật đã merge. |
  | **FR-040.05** | Sau ghi nhận merge, hệ thống MUST NOT gửi push mới hoặc retry publish. |
  | **FR-040.06** | Hệ thống MUST bảo toàn diff chưa commit và commit local chưa publish trong worktree, kể cả phần tạo sau merge; ghi vị trí worktree, head local, phần còn lại và kết quả đối chiếu remote, không xóa/reset/push để khớp head đã merge. |
  | **FR-040.07** | Việc dừng/đối chiếu MUST có timeout, trần retry và thời hạn tổng riêng hữu hạn do plan chốt, không bị chặn bởi deadline thực thi/hạn quan sát PR. |
  | **FR-040.08** | Khi hết giới hạn dừng/đối chiếu mà chưa rõ, hệ thống MUST dừng thử tự động, giữ merge_cleanup_pending và cho recheck một lượt hữu hạn theo FR-046.07; không DONE/CANCELLED theo phỏng đoán. |
  | **FR-040.09** | Restart MUST giữ bằng chứng merge, chặn nghiệp vụ và giới hạn còn lại để tiếp tục dừng/đối chiếu; không reset giới hạn hoặc resume fixer. |
  | **FR-040.10** | Bằng chứng MUST ghi head đã merge và head Cuesura đã kiểm cho revision hiện tại, ghi rõ nếu chưa kiểm; head đã kiểm không tự đổi theo push ngoài và merge commit không bắt buộc bằng head do squash/rebase. |
  | **FR-040.11** | Head khác head đã kiểm hoặc chưa có head đã kiểm MUST vẫn hoàn tất theo FR-040.04, kèm merged_head_unverified và tuyên bố không chứng nhận chất lượng head đã merge; không chuyển chứng cứ chất lượng từ head cũ sang head mới. |
  | **FR-040.12** | Thiếu/mâu thuẫn bằng chứng merge hoặc sai branch đích MUST chờ WAITING/policy để đối chiếu, không tự DONE; lỗi đọc xử lý unknown theo FR-041.08. |
  | **FR-040.13** | Timer CI/deadline/quan sát sau xác nhận merge MUST giữ việc dừng/đối chiếu là bước tiếp theo, không mở lại workflow hoặc thay merge_cleanup_pending; vẫn lưu giới hạn đã chạm. |
  | **FR-040.14** | Lõi MUST nhận bằng chứng merge bên ngoài qua poll/recovery/recheck/cancel, kể cả sau hạn thực thi/quan sát, không yêu cầu approval hoặc effect merge giả; DONE xác nhận merge theo S01, không cấp quyền/chứng nhận chất lượng. |
  | **FR-040.15** | Task terminal MUST NOT mở lại khi nhận bằng chứng remote đến sau. |

- **FR-041**: Quan sát PR và hiệu lực xanh. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-041.01** | Hệ thống MUST quan sát PR theo lịch hữu hạn FR-043, kể cả PR xanh/đóng chưa merge hoặc hết deadline thực thi; merge đã xác nhận chuyển sang FR-040. |
  | **FR-041.02** | Bằng chứng xanh MUST gắn revision, head SHA, tập checks và thời điểm đối chiếu. |
  | **FR-041.03** | Head bị bên ngoài đổi MUST thu hồi xanh và chuyển WAITING/policy với head_changed; không tự nhận head mới, sửa code hoặc ghi đè remote. Khi review A còn chạy mà branch task bị push thành B ngoài dự kiến, approve/result A đến muộn MUST chỉ được ghi đúng provenance, không gỡ blocker, chuyển evidence sang B hoặc tiếp tục publish. Approve đến trước fact drift vẫn MUST qua guard remote/blocker trước publish; restart giữ fact/blocker và intent/receipt. Kiểm H01–H06 trong hợp đồng chế độ. |
  | **FR-041.04** | Chỉ base tip đổi MUST giữ bằng chứng theo head và trạng thái task; không tự cập nhật/rebase, gọi fixer hoặc chạy lại gate/review. Riêng task đang chờ merge có thể chủ động tích hợp base qua execution slot, cả khi tắt yolo, rồi gate/publish/CI trên head mới theo SPEC.md §14.2. Không conflict hoặc một lượt fixer chỉ sửa file conflict được miễn review mới; ngoài phạm vi phải review, chưa xong/conflict lại chờ người. FrozenPolicy không đổi. |
  | **FR-041.05** | Branch đích khác snapshot MUST chuyển WAITING/policy với target_mismatch. |
  | **FR-041.06** | Check bắt buộc pending/fail trên head hợp lệ MUST thu hồi xanh và xử lý CI trong giới hạn; danh sách hợp snapshot/GitHub theo FR-042. |
  | **FR-041.07** | PR đóng chưa merge MUST chuyển WAITING/policy với pr_closed và được quan sát trong hạn; mở lại thì đối chiếu lại, merge thì FR-040. |
  | **FR-041.08** | Lỗi đọc remote MUST trả unknown, WAITING/infra và hiển thị lần quan sát cuối như lịch sử; chỉ lên lịch lần sau khi còn hạn FR-043, không suy ra chưa merge. |

- **FR-042**: Nguồn và đối chiếu required checks. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-042.01** | `ci.required_checks` MUST được đóng băng từ `cusr.yaml` theo revision; sửa file local không thay snapshot. |
  | **FR-042.02** | Mỗi lượt chờ CI/quan sát MUST đọc đầy đủ branch protection/rulesets đang có hiệu lực trên branch đích, không phụ thuộc cờ yolo. |
  | **FR-042.03** | Danh sách phải chờ MUST là hợp tên check trong snapshot và mọi check GitHub đang bắt buộc, kể cả ngoài snapshot và ghim app; thứ tự/duplicate không làm thay đổi kết quả. |
  | **FR-042.04** | Check ngoài snapshot hoặc ghim app MUST NOT tạo required_checks_mismatch mới; MUST lưu tên/app trong evidence. Schema/event/wait cũ MUST vẫn replay được; task ở wait cũ tự đối chiếu và đi tiếp ở lượt quan sát sau, hoặc ci_wait_exhausted nếu cửa sổ CI đã hết. |
  | **FR-042.05** | GitHub xác nhận không có quy tắc MUST ghi github_required: none; vẫn chờ check snapshot/gate/review. Hợp rỗng ở observation giữ hành vi cũ: vào chờ merge, không dùng mọi check trên head làm fallback; riêng yolo không merge và log một lần hướng dẫn khai ci.required_checks. |
  | **FR-042.06** | Không đọc đầy đủ GitHub hoặc thiếu quyền MUST trả unknown, WAITING/infra; không ghi none, coi là khớp hay fallback sang chỉ project. |
  | **FR-042.07** | Ánh xạ check mơ hồ MUST chờ policy. |
  | **FR-042.08** | Chỉ xanh khi mọi check trong hợp đạt (success, hoặc skipped/neutral như branch protection của GitHub khi không check nào của head thất bại hay bị hủy) trên đúng head, cùng gate/review hợp lệ theo FR-019. Trước effect merge, check ghim app MUST đạt từ đúng app_id; không dựa vào GitHub thực thi vì admin có thể bypass. |
  | **FR-042.09** | Phần hợp MUST được tính lại ở mỗi lượt đọc; MUST NOT sửa FrozenPolicy/schema/hash snapshot. Bật/tắt yolo hay lỗi đọc user config MUST NOT đổi danh sách CI/observation; config lỗi chỉ tắt merge và ghi log theo SPEC.md §14.2. |

- **FR-043**: Giới hạn CI, thực thi và quan sát. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-043.01** | Hệ thống MUST duy trì giới hạn chờ CI/thực thi tách khỏi giới hạn quan sát PR. |
  | **FR-043.02** | Mỗi lượt quan sát MUST có timeout và số retry transport hữu hạn. |
  | **FR-043.03** | Chu kỳ poll MUST giãn dần tới trần đã cấu hình, không retry nóng; quan sát không giữ slot hoặc gọi agent. |
  | **FR-043.04** | Vòng quan sát MUST có thời hạn tổng hữu hạn; plan chốt giá trị, mốc tính hạn và lịch backoff. |
  | **FR-043.05** | Restart/đọc thành công/recheck MUST NOT reset hạn quan sát hoặc tạo chuỗi poll trùng. |
  | **FR-043.06** | Hết hạn quan sát MUST ngừng poll và chuyển WAITING/policy với observation_expired, giữ blocker/giới hạn đã chạm và lần quan sát cuối; chỉ recheck đối chiếu một lần, không tự bật lại lịch. |
  | **FR-043.07** | Đối chiếu bắt buộc khi cancel MUST vẫn được thực hiện theo FR-025 sau hạn quan sát, không khôi phục giám sát định kỳ. |
  | **FR-043.08** | Vòng CI mỗi head MUST có trần thời gian/số lần kiểm tra; chạm trần thì WAITING/ci với ci_wait_exhausted và dừng tự động sửa/rerun vòng đó, không gia hạn. |
  | **FR-043.09** | Deadline task MUST bắt đầu khi workflow chạy lần đầu theo SPEC.md §9.4: READY chờ slot đầu chưa tính, chờ xin lại slot có tính; không tạm dừng/reset khi xin slot hoặc restart. |
  | **FR-043.10** | Deadline task hết MUST chặn công việc thực thi mới và chuyển WAITING/policy với task_deadline, trừ giai đoạn dừng/đối chiếu sau merge theo FR-040.13. |
  | **FR-043.11** | CI pass muộn MUST chỉ cập nhật bằng chứng, không reset giới hạn; merge được xác nhận xử lý theo FR-040. |
  | **FR-043.12** | Mọi trạng thái MUST hiển thị lần quan sát cuối, hạn quan sát, lịch kế tiếp hoặc lý do ngừng; dữ liệu cũ không được trình bày là remote hiện tại, lỗi đọc theo FR-041.08. |
  | **FR-043.13** | Merge đã xác nhận hoặc task terminal MUST ngừng lịch quan sát PR; dừng/đối chiếu sau merge theo FR-040.07 và FR-040.13, không bị hạn CI/thực thi/quan sát ngăn cản hoặc đổi lý do chờ. |

- **FR-044**: Slot thực thi và thứ tự chờ. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-044.01** | Daemon MUST cho tối đa `runtime.concurrency` task (mặc định 1) giữ slot thực thi cùng lúc; slot gắn với task, mỗi task giữ tối đa một slot, mỗi worktree tối đa một attempt. Task đang RUNNING MUST giữ slot qua mọi bước và effect tự động (Prepare/setup, agent, gate, autofix, publish, tạo PR, review, fix_review…), không nhả ở ranh giới bước hay khi chạy effect không cần slot; Prepare/setup/gate/autofix/publish và attempt chỉ chạy khi task đang giữ slot. |
  | **FR-044.02** | Task rời RUNNING để chờ CI/merge/người/cooldown MUST giữ slot thành chỗ giữ khi không còn công việc thuộc slot chưa rõ; chờ vì pause/deadline/hủy/dọn sau merge thì trả slot. Chỗ giữ MUST chỉ cho một task READY chưa từng chạy mượn tại một thời điểm, task đó không phụ thuộc và không làm trên PR của task giữ chỗ; số task mượn không quá `runtime.concurrency`. Task mượn không giữ chỗ, không cho mượn tiếp và trả chỗ mượn khi chờ bên ngoài. Poll CI hay việc GitHub khác của task giữ chỗ MUST NOT lấy lại chỗ hay đặt lại hạn. Chỗ giữ quá `runtime.slot_reservation_hours` (mặc định 24) MUST thành slot trống cấp theo FR-044.03. Polling chỉ đọc không chiếm slot, thấy merge không tự nhả claim đang chưa rõ. |
  | **FR-044.03** | Cấp slot MUST theo priority, rồi task đã bắt đầu chờ execution_slot trước READY cùng priority, rồi thời điểm xin slot hiện tại trong cùng nhóm; hòa thì thứ tự event đã commit, không theo lúc tạo task. |
  | **FR-044.04** | Scheduler MUST NOT ngắt task đang giữ slot hoặc đang mượn để cấp cho task khác; ưu tiên task đang dở không bảo đảm chống đói slot. Task giữ chỗ quay lại MUST chạy ngay trên slot của nó, tạm vượt N; khi nó chạy việc cần slot, chỗ giữ được lấy lại và chỗ mượn của lượt giữ chỗ đó kết thúc vĩnh viễn: task mượn làm nốt việc đang chạy và trả chỗ mượn trước việc cần slot kế tiếp, rồi chờ execution_slot như FR-044.05. |
  | **FR-044.05** | Task chờ slot MUST giữ READY nếu chưa chạy, hoặc WAITING/policy với execution_slot nếu đã bắt đầu rồi chuyển RUNNING khi được cấp; không đưa task đã chạy về READY/PENDING để chờ. |
  | **FR-044.06** | Restart MUST bảo toàn thứ tự chờ, lượt giữ slot, chỗ giữ cùng thời điểm bắt đầu giữ (nên thời hạn giữ chỗ tính tiếp), việc mượn và claim chưa rõ. |
  | **FR-044.07** | Hệ thống MUST ghi thời gian chờ slot cho explain, phân biệt READY trước lần chạy đầu với xin lại slot có tính deadline theo FR-043.09; explain MUST phân biệt chờ slot, đang chạy trên slot của mình, đang giữ chỗ và đang chạy trên chỗ mượn. |

- **FR-045**: Giới hạn task retry. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-045.01** | CLI MUST trả lỗi chưa hỗ trợ khi gọi task retry, không tạo task retry hoặc mở lại terminal; task retry và liên kết nguồn nằm ngoài feature 002. |
  | **FR-045.02** | Muốn làm lại, CLI MUST hướng dẫn task add tạo yêu cầu độc lập qua triage/cấu hình/quyền hiện hành, không tự thêm liên kết retry; giới hạn này không xóa mô hình retry lõi 001 hoặc hợp đồng CLI v1 tại SPEC.md §15.1. |

- **FR-046**: Recheck theo trạng thái task. Các nghĩa vụ độc lập:

  | Mã | Yêu cầu |
  | --- | --- |
  | **FR-046.01** | Task recheck MUST yêu cầu quyền operate và request dedup. |
  | **FR-046.02** | Với PENDING/needs_info do config_invalid/capability_missing, recheck MUST đọc base mới nhất và thử kiểm tra/chốt snapshot như confirm theo FR-002; không bỏ qua triage/xác nhận/dependency/quyền. |
  | **FR-046.03** | Với task có PR, recheck MUST đối chiếu PR/CI một lần hữu hạn, lưu bằng chứng và cập nhật trạng thái theo FR-019/040–043. |
  | **FR-046.04** | Recheck MUST NOT reset poll/deadline/ngân sách, gọi agent, gửi merge, kiểm lại/chấp nhận head mới hoặc amend-policy; sửa tiếp chỉ do scheduler xét riêng khi còn giới hạn và đủ slot. |
  | **FR-046.05** | Khi còn hạn quan sát, recheck MUST giữ nguyên lịch tự động, không thay thế hoặc tạo thêm chuỗi poll. |
  | **FR-046.06** | Sau observation_expired, recheck MUST chỉ đối chiếu lần này: thấy merge thì FR-040, chưa merge/unknown vẫn observation_expired và ghi bằng chứng/blocker; không bật poll hoặc mở lại vòng sửa CI hết hạn. |
  | **FR-046.07** | Với merge_cleanup_pending, recheck MUST yêu cầu một lượt dừng/đối chiếu hữu hạn process/effect còn mở và ghi bằng chứng, chỉ DONE khi đạt FR-040.04; thao tác phục vụ này được phép sau deadline/hạn quan sát, không resume workflow/retry publish/reset giới hạn tự động. |
  | **FR-046.08** | Recheck task terminal MUST NOT mở lại task hoặc phát effect nghiệp vụ mới. |

### Method merge mặc định

Theo [SPEC §14.2](../../SPEC.md#142-merge), project có `merge.method` dự kiến, mặc định `squash`,
cho phép `merge`/`rebase`. Object/key thiếu dùng default; sai kiểu/enum hoặc key lạ trong object
closed phải lỗi config_invalid. Resolve từ frozen base, snapshot khi task bắt đầu; config mới
không đổi task đang chạy, không sửa snapshot/hash cũ. Loader, freeze và `cusr show` đã hỗ trợ key này.

Trong feature 002, method và squash message từ artifact worker chỉ để đề xuất cho người dùng;
không bật endpoint/quyền merge hoặc kiểm method GitHub đã bật như điều kiện admission. Merge
thủ công khác cấu hình hoặc không xác minh được method vẫn hoàn tất khi proof/drain đạt. Actual
method chỉ ghi khi có evidence, còn lại unknown; mismatch là audit, không phải blocker hoặc lý do
merged_head_unverified. Checked head, head-at-merge và merge commit vẫn riêng theo FR-040.10.
V1 sau khi có quyền gửi effect merge mới kiểm method được phép và không fallback ngầm.

Coverage thêm vào M02/M05/M08 và T030/T032/T045/T111/T135/T136/T139, không mở scope auto-merge
của feature 002 hoặc thay 117 mã FR hiện có.

### Phạm vi bằng chứng và truy vết

| Hành trình trong SPEC.md | Story / yêu cầu | Bằng chứng cần có ở feature 002 |
| --- | --- | --- |
| S01–S02 Giao task, xác nhận | US1, US6; FR-001–005, FR-027–028, FR-040 | Task thật qua CLI tới PR và DONE sau merge thủ công; PENDING không tạo worktree/agent |
| S03 Sửa gate/review/CI | US2; FR-014–020 | Gate thực tế, review và vòng sửa CI, giới hạn lượt |
| S04 Hỏi giữa chừng | US5; FR-024, FR-037–039 | Inbox/answer bền qua restart; chưa có kênh ngoài CLI |
| S05 Crash giữa agent/publish | US3; FR-006–009, FR-017–018, FR-022–023, FR-030–036 | Process, git và PR được nhận lại; không dựa riêng vào test lõi |
| S06 Hạn mức/hạ tầng | US2, US4–5; FR-010–016 | Phân loại, cooldown và ngân sách với kết quả harness |
| S07 Task phụ thuộc/song song | US1, EC-001; FR-001, FR-044 | `runtime.concurrency` slot theo task, giữ chỗ và cho mượn khi chờ bên ngoài, vòng sửa đợi slot; chưa nghiệm thu song song với harness thật |
| S08 Head/base/quyền merge đổi | US1–2, US5–6; FR-019–021, FR-040–043 | Thu hồi xanh; quan sát merge thủ công; chưa nghiệm thu thực thi merge tự động |
| S09 Yêu cầu thay đổi | Edge Cases; FR-026 | Executor tôn trọng drift/revision; không có decider/overturn |
| S10 Tiến độ/vận hành | US3, US6; FR-022–023, FR-027–029, FR-045–046 | CLI, health, recovery; chưa có backup/restore đầy đủ |

Plan MUST chỉ rõ bằng chứng mới cho I02–I09 ở tầng daemon/runner/effect và giữ kiểm tra hồi quy
I01–I12 của feature 001. I11 chỉ có bằng chứng không phát merge ở feature này; không được báo đã đạt
merge an toàn ngoài hệ thống. R1–R6 và R8 của SPEC.md §18 được kiểm chứng phần liên quan dưới đây;
R7 soak và R9 vận hành đầy đủ vẫn thuộc mốc phát hành v1.

### Key Entities *(include if feature involves data)*

- **Task / FrozenPolicy / FrozenExecutionContext**: yêu cầu, revision và giới hạn đã chốt từ feature
  001, bổ sung liên kết worktree/branch/PR thực tế; không thay mô hình trạng thái.
- **Attempt**: một lần thực thi role với binding/quyền thực tế, process identity, tiến triển, kết quả,
  usage và artifact; phân biệt lượt giữ chỗ với lượt đã dùng.
- **Effect**: thao tác bên ngoài với idempotency key, trạng thái thực thi và bằng chứng đối chiếu.
- **Worktree / Checkpoint**: vùng làm việc do task sở hữu và mốc bảo toàn nội dung trước/sau bước ghi.
- **Artifact**: invocation, log, kết quả chuẩn, gate/review và dữ liệu recovery có nguồn gốc truy vết.
- **Bằng chứng PR/CI**: repo, PR, revision, head dự kiến đã kiểm, head/base quan sát, tập required
  checks đóng băng và kết quả đối chiếu tập con GitHub (phân biệt none/unknown), thời điểm/lịch/hạn
  quan sát và lý do ngừng, giới hạn CI/thực thi, kết quả CI/review, hiệu lực xanh, head đã merge,
  merge commit và merged_head_unverified cùng tuyên bố không chứng nhận khi áp dụng;
  không tự là quyền merge.
- **Bằng chứng hoàn tất sau merge**: merge đã xác nhận, việc chặn nghiệp vụ, process/effect còn mở
  và kết quả dừng/đối chiếu, giới hạn còn lại, diff/commit local chưa publish và vị trí worktree;
  phân biệt thời điểm ghi nhận merge với thời điểm DONE, giữ qua restart.
- **Question / Approval**: câu hỏi và approval escalation gắn task/revision/phạm vi, người có quyền
  trả lời/duyệt; kế thừa cơ chế của lõi.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Ít nhất hai task sandbox thật đi từ yêu cầu qua code, gate, review tới một PR xanh mỗi
  task mà người dùng không sửa tay code: một task dùng Claude làm coder/Codex làm reviewer và một task
  đổi vai vendor. Mỗi task có PR, head, bằng chứng chất lượng và trạng thái chờ merge tra cứu được;
  sau khi chủ dự án merge thủ công đúng head, cả hai task được ghi DONE với merge commit. Số request
  merge do hệ thống gửi bằng 0, kể cả khi nhận lại kết quả merge nhiều lần.
- **SC-002**: Gate khai báo của ít nhất hai hệ sinh thái khác nhau chạy được trên repo sandbox; mỗi
  hệ sinh thái có một mẫu pass và một mẫu fail. Mẫu fail không được publish trước khi được sửa và kiểm
  tra lại thành công.
- **SC-003**: 100% tình huống gate fail, review yêu cầu sửa, CI lỗi code/hạ tầng, rate limit, auth,
  refusal, invalid output và hết hạn mức có kết quả đúng phân loại/giới hạn; không có lượt gọi vượt
  trần hoặc PR được báo xanh bằng chứng cũ/thiếu. Bộ mẫu bao phủ từng trường hợp US2 và US4.
- **SC-004**: Ít nhất 200 lần ngắt daemon có seed tái hiện, phân bố qua khởi chạy/nhận kết quả agent,
  commit, push và tạo PR, đều giữ 100% trạng thái đã commit; projection dựng lại từ nhật ký sau mỗi
  lần khôi phục MUST khớp 100% projection lưu. Không nhân đôi attempt/commit/PR của cùng
  thao tác logic và không mất thay đổi đã bảo toàn. Ma trận có điểm ngắt trước thao tác, sau thành công
  bên ngoài và trước ghi xác nhận; phân biệt số request retry với số hiệu ứng quan sát được.
  Ma trận bao gồm merge được xác nhận khi fixer/push còn chạy, crash sau ghi merge nhưng trước
  dừng/đối chiếu xong: giữ chặn nghiệp vụ, nhận kết quả đến muộn và chỉ hoàn tất một lần (US3.7).
- **SC-005**: Với mỗi harness thật, ít nhất một lần daemon bị dừng khi agent đang chạy rồi khởi động
  lại vẫn nhận đúng attempt và tiếp tục tới PR xanh, không gọi agent thay thế cho attempt đó. Runner
  còn sống qua restart được kiểm chứng riêng ở cả chế độ foreground và service manager.
- **SC-006**: 100% mẫu timeout/stall/cancel dừng hết process thuộc attempt trong thời hạn cấu hình,
  không dừng process ngoài task; mẫu yên lặng nhưng còn tiến triển không bị kết luận stall sai.
  Mẫu xác nhận merge khi còn thực thi cũng phải dừng process thuộc task; chưa chứng minh dừng
  hoặc effect chưa rõ thì không DONE, giữ merge_cleanup_pending và đường recheck hữu hạn.
- **SC-007**: 100% task chờ trong bộ nghiệm thu có lý do, điều kiện tiếp tục/giới hạn và cách kết thúc
  đọc được; gửi lại câu trả lời hoặc yêu cầu từ 2–5 lần không làm nhân đôi quyết định hay attempt.
  Bao phủ từng detail/lối ra của FR-029 qua explain; PENDING lỗi cấu hình/năng lực không tự thử lại,
  confirm/recheck đọc base mới nhất và request lặp không nhân đôi snapshot/cấp việc (US1.8).
- **SC-008**: Cả hai harness có bằng chứng chấp nhận và trả đúng kết quả cho cả ba role được hỗ trợ.
  Toàn bộ mẫu sai/cắt cụt/cũ bị từ chối đúng; secret thử nghiệm không xuất hiện trong log/context đã
  lưu hoặc kết quả CLI, và usage không có được biểu diễn là unavailable.
- **SC-009**: Báo cáo nghiệm thu liệt kê đủ I01–I12, S01–S10 và R1–R9, ghi phạm vi/bằng chứng hoặc
  chưa đạt/chưa kiểm tương ứng. Kiểm thử giả lập, tích hợp với tiến trình/git thực tế và smoke dùng
  tài khoản/harness thật được phân biệt; không dùng kết quả giả lập để tuyên bố đã đạt smoke thật.
- **SC-010**: 100% mẫu PR xanh rồi đổi head/checks, bị đóng hoặc mất khả năng đối chiếu thu hồi đúng
  hiệu lực xanh và có lý do/đường tiếp tục. Base tip đổi đơn lẻ không thu hồi bằng chứng theo head,
  không tự sửa/cập nhật base/chạy lại kiểm tra. GitHub có check ngoài snapshot hoặc không đọc được
  không được báo xanh; GitHub yêu cầu tập con hoặc xác nhận không có quy tắc vẫn xét xanh khi đủ
  checks snapshot/gate/review, ghi none riêng với unknown. Poll tiếp tục qua PR đóng, hết cửa sổ CI
  và deadline task trong hạn quan sát; 100% mẫu hết hạn tổng ngừng poll với observation_expired,
  kể cả restart; backoff không vượt trần. Không thêm agent/rerun sau khi hết giới hạn thực thi.
- **SC-011**: Trong mẫu hai task xen kẽ, task A chờ CI/merge không giữ slot; B chạy được; khi A cần sửa
  trong lúc B đang chạy, A đợi đúng thứ tự. Có mẫu nhiều task đang dở và READY: priority trước,
  cùng priority ưu tiên task đang dở, cùng nhóm theo thời điểm xin slot (hòa thì thứ tự event),
  không theo lúc tạo task. Không thời điểm nào có hơn một task giữ slot, kể cả restart.
  Mẫu READY chưa chạy không tiêu deadline; mẫu xin lại slot sau lần chạy đầu vẫn tiêu deadline,
  hết hạn không được cấp công việc nghiệp vụ mới. Explain hiển thị thời gian chờ slot riêng.
- **SC-012**: 100% mẫu merge vào đúng branch đích trong khi chờ hoặc xử lý cancel kết thúc DONE
  đúng một lần sau khi dừng/đối chiếu xong với bằng chứng; head khác head đã kiểm ghi merged_head_unverified, hai head và
  tuyên bố không chứng nhận chất lượng head đã merge. Thiếu bằng chứng/sai branch đích không tự DONE.
  Bao phủ sau deadline thực thi khi còn poll và sau observation_expired qua recheck; recheck chưa
  merge/unknown không bật lại poll. Task retry báo chưa hỗ trợ và không tạo task; task add tạo yêu
  cầu độc lập, không liên kết retry. Recheck không reset hạn mức, gửi merge, kiểm lại head mới hay
  tự gọi agent; terminal không bị mở lại.
  Bao phủ merge lúc fixer/push còn chạy, push đến muộn thành công, dừng/đối chiếu unknown hoặc hết
  hạn rồi recheck: không gửi publish mới, không DONE/trả claim sớm, giữ diff/commit local và ghi
  đúng kết quả effect. Dependency chỉ được giải phóng sau DONE, kể cả merged_head_unverified;
  explain của task phụ thuộc hiển thị dấu chưa chứng nhận và liên kết bằng chứng (US1.9–10).

## Assumptions

- Phạm vi A được người dùng chốt, bổ sung đường kết thúc khi người dùng tự merge vào branch đích,
  kể cả khác head đã kiểm với merged_head_unverified. Thực thi merge và yolo thuộc feature sau;
  quan sát merge và ghi DONE thuộc feature này.
- Đây là feature rộng, chủ đích gộp luồng xuyên suốt với phần recovery/tương tác cần thiết. Plan MUST
  giao theo thứ tự: spike ngày 1 → US1/2/4 với fake → US3/5/6 và crash matrix → smoke thật; không được coi lát fake
  đạt là đã hoàn thành toàn feature hoặc bỏ các tiêu chí 200 lần ngắt/smoke để thu nhỏ ngầm phạm vi.
- Feature 001 là nền về quyết định, snapshot, ngân sách, store/outbox/timer; feature 002 phải nối vào
  và kiểm tra hồi quy nền đó. [Báo cáo feature 001](../001-deterministic-core/acceptance-report.md)
  chưa chứng minh hành vi runner/worktree/GitHub, nên không thay thế bằng chứng thực thi ở đây.
- Môi trường là một người dùng trên Linux/Ubuntu hoặc WSL2 với dữ liệu runtime trên filesystem Linux.
  Giới hạn một task thực thi là mặc định để nghiệm thu luồng đầu tiên, không thay phạm vi song song v1.
- Cấu hình repo, profile và credential được người vận hành chuẩn bị trước. CLI feature này chưa phải
  toàn bộ CLI v1; không thêm trình thiết lập, quản trị policy hay nguồn task ngoài CLI để hoàn thành mốc.
- Bộ nghiệm thu SC-001 dùng `full-review`; bổ sung M01–M08 cho cả `direct-pr` và `full-review`
  cùng vendor. Danh sách CI required checks trong snapshot không rỗng, có cả trường hợp GitHub
  xác nhận không có protection/rulesets áp dụng. Quy tắc
  profile khác vẫn theo SPEC.md; chưa hỗ trợ thì báo rõ trước chạy, không suy luận “không biết check”
  thành “không có check”.
- Cần repo sandbox GitHub, quyền chạy CI và quyền sử dụng hai harness cho smoke. Nếu thiếu, tiêu chí
  thật tương ứng phải ghi chưa kiểm; việc viết spec không tự chạy agent trả phí hay publish PR thử.
- Khả năng harness được coi là giả định cần spike có phiên bản/bằng chứng trước triển khai adapter;
  spec này không khẳng định cờ lệnh, auth hay giới hạn quyền/chi phí nào đã được xác minh.
- Ngưỡng 200 lần ngắt lấy từ R1, áp vào daemon/effect thuộc feature này. Ma trận giả lập phải được
  bổ sung smoke thật theo SC-005; đạt feature 002 chưa đồng nghĩa đạt toàn bộ Reliability Gate v1.
- Hợp đồng chi tiết runner, CLI, phân loại lỗi và baseline kế thừa SPEC.md §§9, 12–17 cùng
  [constitution](../../.specify/memory/constitution.md); lựa chọn thiết kế và các file triển khai sẽ
  được ghi trong plan.
