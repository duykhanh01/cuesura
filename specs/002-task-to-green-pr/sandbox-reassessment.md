# Đánh giá lại yêu cầu AppArmor 4 của feature 002

Ngày: 2026-10-28. **Kết luận đề xuất: không bắt buộc AppArmor 4 và Ubuntu 24.04 cho mọi người dùng.**
Giữ cách ly OS, kiểm quyền và kiểm chứng trên host thật. AppArmor child stack là một cơ chế tăng
cường bảo vệ có ích, nhưng bằng chứng hiện có không cho thấy đây là cơ chế duy nhất đáp ứng trust
boundary v1.

Đây là đánh giá và thí nghiệm bổ sung. Quyết định tiếp theo đã ghi ở
[ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md): chọn Isolated rootless bwrap, cập nhật
spec/plan/contracts/tasks/runbook, thay prerequisite AppArmor phổ quát của ADR-0003.
**Gate S0.1 vẫn BLOCKED.** Không nạp/gỡ profile, đổi sysctl/WSL config, gọi model hoặc GitHub.

Đánh giá bổ sung phạm vi sandbox của harness tại mục 4a. Baseline tự động v1 giữ lớp ngoài cho toàn
bộ harness/repo commands; lớp nội bộ bật trước, ngoại lệ chỉ theo ADR-0004 và proof từng cấu hình.
Native-only/Container/VM chưa triển khai; một port SandboxProvider nhỏ và backend bwrap duy nhất.

## 1. Yêu cầu sản phẩm và lựa chọn cơ chế

[Hiến chương](../../.specify/memory/constitution.md) yêu cầu secret điều phối/admin ngoài tầm agent,
quyền read/operate/admin kiểm ở application service, và doctor chặn tự động hóa nếu không chứng
minh được boundary. Hiến chương không yêu cầu AppArmor 4, Ubuntu 24.04 hay cấm mọi user namespace
con. [SPEC §15](../../SPEC.md) đặt v1 cho repo đáng tin, đồng thời không mặc
định coi agent/build command là vô hại. Vì vậy vẫn cần sandbox OS; bỏ sandbox hoặc chỉ dựa prompt/
deny rules của harness không đáp ứng mục tiêu đã chốt.

[ADR-0003](../../docs/adr/0003-bwrap-child-capabilities.md) trước đây chọn thêm child stack deny capability,
và spike 0 khi đó biến việc có nhãn/audit này thành điều kiện pass trên mọi host. Lựa chọn
đó đã gộp hai mục tiêu khác nhau: bảo vệ filesystem/process/secret của Cuesura và giảm bề mặt
kernel qua capability trong namespace con.

Canonical mô tả userns restriction là một lớp hardening giảm bề mặt tấn công kernel. Quyền root
trong user namespace không tự trở thành quyền root host. Đây không phải lý do bỏ hardening của
host, nhưng cũng không đủ để suy ra mọi sản phẩm dùng namespace phải yêu cầu AppArmor 4.
[Nguồn Canonical](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007).

## 2. Đánh giá lại lý do “agent có thể gọi/copy bwrap”

Theo Linux man-pages, user namespace mới không cấp capability trong namespace cha. Namespace mount
kém đặc quyền hơn kế thừa các mount có khóa; hạn chế read-only không được tự gỡ trong namespace
đó. Vì vậy tạo namespace con thành công hoặc thấy CapEff khác 0 chưa tự chứng minh thoát sandbox.
[User namespaces](https://man7.org/linux/man-pages/man7/user_namespaces.7.html),
[Mount namespaces — restrictions](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html).

Bubblewrap là bộ công cụ, không tự cung cấp policy hoàn chỉnh. Cuesura vẫn chịu trách nhiệm về
mount, proc/PID, stdio/FD, env, socket và các quyền đã lộ vào sandbox. Những thứ đã bind vào không
được coi là an toàn chỉ vì có bwrap; đặc biệt không đưa bus điều phối vào sandbox.
[Security policy của bubblewrap](https://github.com/containers/bubblewrap/blob/main/SECURITY.md),
[README — limitations](https://github.com/containers/bubblewrap#limitations).

**Nhận định được sửa:** việc binary bwrap có thể exec trong `/usr` hoặc copy vào scratch không đủ
để kết luận agent có thể nhìn lại root host hoặc bỏ readonly của reviewer. Cần thử chính hành vi
vi phạm trust boundary thay vì dùng “namespace con bị EPERM” làm đại diện cho mọi mục tiêu cách ly.

## 3. Thí nghiệm local đã chạy

Script tái hiện: [reassess-sandbox.ts](https://github.com/duykhanh01/cuesura/blob/63cae62/scripts/spike-002/reassess-sandbox.ts).
Kết quả đầy đủ: [sandbox-reassessment.json](evidence/sandbox-reassessment.json).

```sh
node scripts/spike-002/reassess-sandbox.ts
```

Script dùng lại `createProbeFixture`, `probeLayout`, `buildSandbox` hiện có. Tất cả thao tác ghi,
remount/unmount chỉ nhắm fixture tạm; không nhắm repo sản phẩm hoặc secret thật. Fixture được dọn
sau khi chạy. Đây là kiểm hành vi namespace bằng syscall thông thường, không chạy exploit kernel.

Môi trường: Node v24.22.1, bubblewrap 0.6.1, kernel `6.18.54.1-microsoft-standard-WSL2` trên
Ubuntu 22.04.5/WSL2. Process trong **mọi lượt** có nhãn `unconfined`, không có child stack
`cusr-bwrap-child`. AppArmor được bật ở kernel hiện tại; kết quả không chứng minh mọi cấu hình
kernel tắt/bật AppArmor hoặc mọi bản Ubuntu 22.04 đều tương đương.

| Cách chạy bên trong outer sandbox | Role | Kết quả |
| --- | --- | --- |
| Baseline | coder, fixer, reviewer, setup, gate | 5/5 lượt đạt |
| Chạy lại `/usr/bin/bwrap`, tạo namespace con và bind `/` của outer sandbox | Cùng 5 role | 5/5 lượt đạt |
| Copy bwrap sang scratch rồi chạy cùng kịch bản | Cùng 5 role | 5/5 lượt đạt |
| `unshare --user --map-root-user --mount`, không nhờ bwrap tạo lớp con | Cùng 5 role | 5/5 lượt đạt |

Tổng **20 lượt × 18 kiểm tra = 360 kiểm tra đạt**. Positive controls xác nhận worktree/context
đọc được, scratch/home ghi được và vùng ghi coder/fixer/setup/gate vẫn hoạt động. Negative controls
xác nhận canary ngoài mount không đọc được, đường control không hiện, `/proc/1/root` và đường PID
host không làm lộ canary, `.git`/Git common/context không mở ghi được, reviewer không tạo file
trong worktree và không có FD canary/control kế thừa.

Ở nhánh raw userns, CapEff là `000001ffffffffff` trong namespace con. Tuy vậy, remount `.git`
thành rw trả EPERM, gỡ overlay `.git` trả EINVAL, mọi canary giới hạn truy cập vẫn đạt. Hai nhánh
bwrap có CapEff bằng 0, remount/unmount trả EPERM. Đây là phản ví dụ local cho giả định “capability
trong namespace con đồng nghĩa vượt giới hạn filesystem host”; không phải chứng minh an toàn
tuyệt đối của namespace trước lỗi kernel.

Phạm vi chưa kiểm ở script này: kết nối tới socket thật (canary hiện chỉ kiểm đường dẫn control),
mọi kênh FD/IPC, race khi chuẩn bị mount, kernel khác, native Claude/Codex, auth/session thật,
network registry/vendor, syscall/kernel exploit và toàn bộ runner lifecycle. Dữ liệu mạng vẫn theo
quyết định internet_outbound của feature: không tuyên bố chặn LAN/loopback. Kết quả runner/systemd
với fake child trước đó vẫn được giữ riêng trong [spike report](spike-0-report.md).

## 4. Chi phí vận hành và lựa chọn

Userspace chuẩn Ubuntu 22.04 là AppArmor 3.0.4, Ubuntu 24.04 là 4.0.1 theo tài liệu Canonical.
Bắt buộc profile ABI 4.0 làm người dùng 22.04 phải tự chuẩn bị userspace khác hoặc đổi môi trường.
[Ubuntu security documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

Profile hiện tại attach `/usr/bin/bwrap`, nên ảnh hưởng ứng dụng khác sử dụng binary đó; runbook
đã ghi tác động đến Flatpak/harness tương tác. Canonical cũng lưu ý profile bwrap có thể ảnh hưởng
các ứng dụng khác và cần quản trị viên hiểu policy. Đây là chi phí thật khi phân phối CLI cá nhân;
không nên biến nó thành mặc định chỉ để khớp một tên profile trong acceptance.
[Runbook hiện tại](../../deploy/README.md),
[Canonical — purpose-built bwrap profile](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007).

| Phương án | Đánh giá |
| --- | --- |
| AppArmor 4 + child capability-denial bắt buộc trên mọi host | Có thêm hardening; setup/kernel/userspace/audit và tương thích nesting tốn công, tác động ngoài Cuesura. Chưa chứng minh cần thiết làm baseline v1 |
| Rootless bwrap với policy mount/PID/FD/env chặt + runner trong systemd unit | **Ứng viên baseline nên kiểm chứng tiếp**; tái sử dụng prototype hiện có, không ép AppArmor 4 trên host vốn chạy userns được; vẫn doctor fail-closed khi boundary chưa đạt |
| Chặn namespace con bằng tùy chọn bwrap hoặc seccomp | Cân nhắc nếu threat model thực sự yêu cầu giới hạn này. Cần thêm compatibility test và có thể làm hỏng native sandbox của harness; không thêm ngay để thay một gate tên khác |
| Thêm container engine hoặc VM làm backend mặc định | Chưa cần thêm backend/phụ thuộc vận hành cho v1 chỉ để giải quyết lỗi lựa chọn profile; cần đánh giá riêng nếu threat model yêu cầu cách ly kernel |

Tùy chọn `--disable-userns` được mô tả trong tài liệu bwrap v0.8.0, nhưng binary 0.6.1 đang dùng
không có. Bwrap 0.6.1 có thể nhận seccomp cBPF qua FD. Hai cơ chế này chỉ là lựa chọn giảm bề mặt
syscall/namespace cần nghiên cứu nếu cần; không được tự giả định tương thích nested harness.
[bwrap v0.8.0](https://github.com/containers/bubblewrap/blob/v0.8.0/bwrap.xml),
[bwrap v0.6.1 — seccomp](https://github.com/containers/bubblewrap/blob/v0.6.1/bwrap.xml).

Trên host có policy AppArmor hạn chế userns, vẫn phải tuân thủ policy đó và có provisioning phù
hợp nếu cần. Đề xuất này không tắt AppArmor/sysctl, không override managed policy và không cam kết
mọi người dùng đều cài được mà không cần quyền admin. Phân biệt quyền để khởi tạo namespace trên
host với yêu cầu bắt buộc mọi descendant phải mang child stack của Cuesura.

Ứng viên rootless bwrap không có child capability-denial sẽ có ít hardening kernel hơn cấu hình
ADR-0003. Không coi hai cấu hình tương đương về mọi mặt hoặc coi canary pass là bằng chứng chống
kernel exploit; đánh đổi này phải được review cùng threat model trước khi đổi baseline. Chọn
kernel/bwrap có bản vá bảo mật được duy trì; binary 0.6.1 trong kết quả chỉ định danh tổ hợp đã
thử, không phải đề nghị ghim một bản cũ cho mọi người dùng.

## 4a. Có thể chỉ dùng sandbox của harness không?

**Nên tái sử dụng sandbox native, nhưng phạm vi của nó không mặc nhiên bao phủ toàn bộ workflow.**
Điều này không chứng minh cần AppArmor 4. Một lớp launcher dùng bwrap có sẵn để áp policy chung
khác với tự viết một sandbox engine hoặc buộc mọi host nạp profile toàn hệ thống.

Theo tài liệu OpenAI hiện tại, Codex Linux dùng bwrap + seccomp; sandbox áp dụng cả lệnh và process
con. Permission profiles cho phép giới hạn đọc. Cần chứng minh policy thực tế thay vì suy từ tên
workspace-write/read-only rằng secret điều phối đã bị che.
[Official OpenAI documentation — sandbox](https://learn.chatgpt.com/docs/agent-approvals-security),
[permission profiles](https://learn.chatgpt.com/docs/permissions).

Claude mô tả sandbox chủ yếu bọc shell commands; Read/Edit/Write, hooks và MCP chạy ngoài lớp
này, theo permission rules riêng. Vì vậy không suy việc Bash bị chặn chứng minh cả process Claude
không đọc secret. Tài liệu khuyên bọc process nếu cần boundary cho toàn bộ các đường chạy này.
[Claude — scope](https://code.claude.com/docs/en/sandboxing#what-runs-outside-the-sandbox).

| Thành phần workflow | Ai chịu trách nhiệm boundary? |
| --- | --- |
| Tool do agent gọi | Tận dụng sandbox/permissions của harness, kiểm đúng vendor/version/role |
| Setup/gate/autofix do Cuesura spawn trực tiếp | Cuesura phải cách ly; không kế thừa sandbox của một invocation agent khác |
| Secret DB/control/GitHub của orchestrator | Cuesura giữ ngoài env/home/FD/mount worker; native-only phải chứng minh đủ mọi đường truy cập |
| Process con thoát process group, daemon restart/stop | Runner/systemd cgroup quản lý; không gộp trách nhiệm này với filesystem sandbox |
| Git/publish của orchestrator | Trusted port/argv/credential scope riêng; không đưa quyền publish cho agent |

Có thể nghiên cứu cấu hình **native-only cho agent + bwrap cho repo commands** ngoài phạm vi v1,
nếu policy của mỗi
harness chứng minh được tất cả yêu cầu secret/read/write/tool và không có đường thực thi ngoài
policy đã cho phép. Đó là ứng viên bổ sung, chưa phải cấu hình proven; hiện chỉ có fixture harness,
không có smoke vendor thật. Giữ generic outer bwrap mỏng có lợi thế dùng cùng một boundary cho cả
process harness lẫn repo commands; chưa thấy cần thay thế phần này chỉ để gỡ phụ thuộc AppArmor 4.

Chứng cứ nested bwrap của mục 3 chỉ áp dụng layout tối thiểu của Cuesura. Claude cảnh báo bật nested
user namespaces có thể làm mất boundary của sandbox riêng của nó. Không dùng 20 lượt canary để
bác cảnh báo đó hoặc tự bật tùy chọn tương ứng trong Claude.
[Claude — nested namespace limitation](https://code.claude.com/docs/en/sandboxing#chromium-or-rootless-podman-fails-inside-the-sandbox-on-linux).

Các tài liệu được đối chiếu ngày 2026-10-28; không khẳng định mọi khả năng mới trong docs đều có
trong binary Claude/Codex đang pin. Native proof ở S0.1/S0.2 vẫn bắt buộc trước khi chọn mode.

## 5. Đề xuất thực hiện tiếp

1. Chọn tiêu chí S0.1 theo **kết quả bảo mật**: không đọc secret/control/host proc, không ghi repo
   của reviewer hoặc Git metadata, không nhận quyền từ FD/socket, không thoát ownership cgroup;
   giữ explicit permission/approval và bounded operations.
2. Bổ sung proof rootless bwrap: socket/FD thật, unmount/remount/re-exec/copy/raw-userns regressions,
   mount race và tất cả vùng rw được cấp. Giữ `no_new_privs`, cap drop, fresh proc/PID, new-session,
   env allowlist, no bus/admin/operate/GitHub credential, systemd unit/cgroup và bảo toàn dữ liệu.
3. Thử native harness trước trên chính môi trường triển khai. Chỉ xét mode khác khi owner cho phép,
   outer boundary proven và permission/approval được kiểm độc lập. Không bỏ guard hoặc dùng bypass.
4. Lập compatibility matrix có OS/kernel/bwrap/version/proof cụ thể. Kết quả hiện tại chỉ là một
   tổ hợp WSL2; chưa tuyên bố hỗ trợ toàn Ubuntu 22.04/24.04 hoặc mọi WSL.
5. Đã ghi quyết định baseline tại ADR-0004, đánh dấu ADR-0003 được thay thế và đồng bộ spec,
   plan/research, execution/CLI/data model contracts, spike guide/report, tasks và deploy runbook.
   Không đổi MUST của hiến chương; nếu chưa chứng minh đủ boundary thì tiếp tục chặn thực thi.

**Gate hiện tại giữ BLOCKED.** Đã bỏ yêu cầu AppArmor 4 phổ quát khỏi thiết kế và chuyển sang
kiểm chứng boundary; chưa đủ để đánh dấu T006/S0.1 đạt. Phần local T002/T006 có thể chạy tiếp;
phần model/GitHub đợi đầu vào và quyền/budget T001, không tự mở từ quyết định này.

## 6. Định danh bằng chứng

SHA-256 của đúng các file dùng trong lượt chạy này:

- probe: `b83a6a550a4d6da45c4e4351b6c509e0dbcd095d24acb59e8fa0f737f752f30b`
- sandbox builder: `93ce6ad37689474d7a9c4ac45933f39685d5fc6da1f80f90b9a68a03ede793df`
- bwrap: `bf6cf3d4456665f5d80c14eb79a76e0ce87b39a0883e614a161658b4ec33492c`
- evidence: `78e63688ad90b891711d540bb9ab7dc9210d185e111abb0aa4aa5d1bca0093e7`

## 7. Kiểm tra hồi quy

Sau khi thêm probe đánh giá: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` đều exit 0;
default có 48 file/479 test đạt, duration 22,97 giây. Probe namespace được chạy riêng với 20 lượt/
360 kiểm tra như mục 3. Đây không phải reliability 200 crash, smoke harness thật hoặc pass S0.1.
