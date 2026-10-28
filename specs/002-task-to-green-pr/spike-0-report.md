# Lát 0 — Báo cáo hiện trạng ngày 2026-10-28

**Kết quả tổng hiện tại: BLOCKED trước A.** Backlog đã có; cập nhật thiết kế không tự mở runtime.
Theo [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md), baseline là **Isolated rootless
bwrap + systemd user unit**, không bắt buộc AppArmor 4/Ubuntu 24.04/child stack Cuesura. Giữ nguyên
trust boundary của hiến chương và điều kiện ngoại lệ cho sandbox nội bộ, không có Native-only backend.

| Gate / task tiếp theo | Bằng chứng hiện có và việc còn thiếu |
| --- | --- |
| T002: kiểm host và đồng bộ prototype | Userns/bwrap 0.6.1 có kết quả local đạt; cần pin host/version/policy và user-unit probe, cập nhật scope/comment/report prototype còn nhắc child stack bắt buộc. Không cần cài profile riêng nếu host đã chạy được và proof đạt |
| T006 / S0.1 local | 20 lượt/360 checks đạt, không child stack, xem [reassessment](sandbox-reassessment.md). Thiếu FD/socket thật, path/mount-race, toàn bộ vùng rw, lifetime trên host triển khai; chưa là full outer proof |
| T001 + T006/T007 / S0.1–S0.2 vendor | Chưa có native nội bộ/permission/auth/schema thật từng vendor/role; cần pin binary/model/effort/auth và quyền/budget chung 6 lượt × 5 phút, kể cả failure |
| T001 + T008 / S0.3 | Chưa có repo GitHub sandbox được cấp và proof merge/squash/rebase + source push/delete; merge do người dùng thực hiện |
| T009 | Chỉ tổng kết pass sau đủ ba gate, không dùng docs/quality gates/fake làm bằng chứng thay |

Phần local T002/T006 có thể làm trước khi có credential/model/repo remote; không gọi model/GitHub
trong lượt cập nhật tài liệu. T003–T005 giữ hoàn thành theo phạm vi prototype. AppArmor label/audit
nếu chọn hardening vẫn ghi riêng, không nâng 360 checks thành chứng minh chống kernel exploit.

Kiểm tra tài liệu sau ADR-0004: liên kết nội bộ còn tồn tại, `git diff --check` đạt; giữ 134 task
với 32 `[P]`, chỉ T003–T005 hoàn thành, đủ 117 dòng coverage FR không trùng. Lượt này chỉ sửa tài
liệu, không chạy lại quality gates mã nguồn hoặc thêm bằng chứng runtime.

## Lịch sử chẩn đoán theo thiết kế trước ADR-0004

Các bảng/điều kiện bên dưới giữ nguyên nguồn và phạm vi của từng lượt chạy, không phải gate
AppArmor hiện hành. Chúng ghi chẩn đoán host và kiểm cú pháp, không phải thành công của toàn spike.

| Kiểm tra thực tế | Kết quả | Phạm vi bằng chứng |
| --- | --- | --- |
| `sysctl kernel.apparmor_restrict_unprivileged_userns` | `1` | Restriction host đang bật |
| `bwrap --version` | `bubblewrap 0.9.0` | Version executable được probe |
| `bwrap --unshare-user --ro-bind / / /usr/bin/true` | Exit 1, `setting up uid map: Permission denied` | Host namespace không chạy được; phải provisioning, không chỉ lỗi phiên agent |
| `apparmor_parser --version` | `4.0.1` | Parser host |
| `apparmor_parser --skip-kernel-load --skip-cache deploy/apparmor/cusr-bwrap` | Exit 0 | Profile parse/compile được; không nạp kernel, không chứng minh userns đã hoạt động |
| `systemctl --user is-system-running` | `degraded` | Manager có phản hồi; chưa thử tạo/dừng unit hoặc chứng minh runner lifetime |

Chủ dự án đã kiểm tra không có AppArmor profile cho bwrap. Lượt này không nạp profile, đổi sysctl,
chạy sudo install, gọi model trả phí, tạo PR hoặc gửi merge request. File provisioning và lệnh
quản trị review được tại [deploy](../../deploy/README.md).

| Gate | Trạng thái / việc còn lại |
| --- | --- |
| S0.1 | Host fail; profile mới hai lớp chỉ compile; cần outer proof/lifetime, native result và permission evidence cho mode được chọn |
| S0.2 | Chưa chạy 6 role/vendor outputs, auth home riêng, quyền và registry/vendor network |
| S0.3 | Chưa có repo sandbox/fixture merge/squash/rebase + push/delete source; không dùng repo sản phẩm để thử |

Giới hạn kế hoạch của thử model là 6 invocation đầu, mỗi invocation tối đa 5 phút. Chưa dùng usage
hoặc xác nhận quyền chạy model/GitHub từ việc viết kế hoạch. Sau provisioning và được cấp đầu vào
spike, cập nhật từng dòng bằng command/exit code/fixture hash thật theo [spike guide](spike-0.md).
Không đổi BLOCKED thành pass chỉ vì typecheck/lint/test/build của lõi xanh.

Kiểm tra hồi quy sau khi sửa docs và thêm profile: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build` đều exit 0; default tests có 40 file/324 test đạt (33,12 giây). Kiểm tài liệu đủ
117 mục FR truy vết/12 SC, liên kết nội bộ và ADR một đoạn đạt. Các kết quả này không kiểm việc
nạp AppArmor, nested sandbox hoặc schema/auth/output model thật của S0.1–S0.3.

## Sửa profile sau review capability

Profile unconfined trong commit `113faef` đã bị thay bằng hướng (a), theo mẫu AppArmor v4.0.2 ABI
4.0 và [ADR-0003](../../docs/adr/0003-bwrap-child-capabilities.md). Không ghi nhận hướng (b) là
rủi ro đã chấp nhận. Parser 4.0.1 compile profile mới exit 0 và liệt kê hai profile `cusr-bwrap`,
`cusr-bwrap-child`; không nạp vào kernel. Fixture Python parse đạt và khi chạy ngoài child stack
enforce đã exit 1 trước probe, đúng yêu cầu guard. Chưa chạy fixture dưới policy đã nạp, chưa có
audit capability denial, re-exec/copy hoặc nested harness evidence; S0.1 vẫn **BLOCKED**.

Sau bản sửa capability, đã chạy lại typecheck/lint/test/build: tất cả exit 0, 40 file/324 test
đạt trong 33,55 giây. Đây là hồi quy của codebase, không thay bằng chứng S0.1 còn thiếu.

## Điều kiện pass được điều chỉnh sau review nesting

ADR-0003 cho phép external_verified có điều kiện sau khi outer boundary được chứng minh và tool
+permission/approval vẫn được kiểm độc lập; S0.1 vẫn phải thử native sandbox đang bật và giữ kết
+quả native riêng. Hiện **chưa có outer proof hoặc mode fallback proven**, nên ngoại lệ chưa được
+kích hoạt, native/fallback đều chưa được báo pass; trạng thái BLOCKED giữ nguyên.

## Prototype T003–T005 (2026-10-28)

**Không đổi trạng thái gate: S0.1–S0.3 vẫn BLOCKED.** Lượt này chỉ xây prototype và kiểm thử local
theo [hướng dẫn lệnh](spike-0.md#prototype-và-lệnh-chạy-t003t005). Không nạp profile, không sudo,
không gọi model trả phí, không gọi GitHub, không tạo PR hay push.

Nguồn bằng chứng được tách theo từng môi trường:

| Nguồn | Quan sát | Phạm vi |
| --- | --- | --- |
| Terminal host của người dùng (người dùng tự báo, agent không chạy lại) | `bubblewrap 0.6.1`; `bwrap --unshare-user --ro-bind / / /usr/bin/true` không báo lỗi; `systemctl --user is-system-running` = `running` | Chỉ là prerequisite cơ bản. Chưa chứng minh isolation, runner lifetime, harness hay GitHub |
| Máy worker của agent, lệnh chạy trực tiếp | Ubuntu 22.04.5, kernel `6.18.54.1-microsoft-standard-WSL2`; `bubblewrap 0.6.1`; không có sysctl `kernel.apparmor_restrict_unprivileged_userns`; `bwrap --unshare-user ...` exit 0; `systemctl --user` = `running`; Node `v22.22.0` (package pin `24.22.1`); Claude Code `2.1.306`, codex-cli `0.164.0`, gh `2.103.3` | Đây không phải host bwrap 0.9.0/sysctl=1 ở bảng đầu báo cáo. Không suy ra host triển khai đã được provisioning |
| Worker: `sandbox.ts probe --all` | Canary mount/PID/env/secret/control đạt cho coder/fixer/reviewer/setup/gate. Nhãn AppArmor trong sandbox là `kernel` | Chỉ chứng minh layout. **Không có child stack `cusr-bwrap-child`**, không có capability-denial audit, chưa chạy `probe-child.py` dưới policy. Không phải outer proof của S0.1 |
| Worker: `test/integration/spike-002/runner-systemd.test.ts` | Unit `cusr-op-*` vẫn sống sau khi process khởi chạy thoát; `systemctl --user stop` dừng cả process con cùng group lẫn process con đã `setsid`; exit.json ghi `cancelled`, `unit_cgroup` | Child giả local. Chưa thử stop/restart `cusrd.service` thật, chưa chạy trên host triển khai |
| Worker: harness vendor `fixture` qua bwrap + runner | Kết quả chỉ được chấp nhận khi output mới đúng attempt, đạt schema và semantic, và process exit 0; output stale, cắt cụt hoặc của process lỗi bị từ chối; provenance lấy từ launch marker | Không phải output Claude/Codex. Capability của cả hai vendor vẫn `unknown` |
| Worker: gh port trên fixture synthetic | Chỉ GET, endpoint allowlist, cap timeout/byte/page/call/send, evidence đã redact + digest; required checks không đọc được → `unknown`; app-pinned → mismatch | Không có response GitHub thật. Head-at-merge mới là ứng viên chưa kiểm chứng |

Kiểm tra hồi quy sau T003–T005: `pnpm typecheck`, `pnpm lint`, `pnpm test` và `pnpm build` đều
exit 0; default có 48 file/479 test đạt. Test bwrap/systemd chạy được trên worker; host không cho
userns sẽ skip các test đó, và skip được tính là chưa chạy.

Đầu vào còn thiếu để chạy S0.1–S0.3 thật (T001/T002/T006–T008):

- Host triển khai do quản trị viên provisioning profile `cusr-bwrap`, có audit log cho cửa sổ
  probe. Sau đó chạy `sandbox.ts probe --all --apparmor-fixture`, re-exec/copy bwrap và native
  sandbox từng harness trên chính host đó.
- Quyết định của owner về `allow_external_verified` cho từng harness, đặt trong config trusted
  ngoài repo. Chỉ áp dụng khi native đã fail và có outer proof/permission fixture.
- Binary Claude/Codex được pin (path, sha256, version), model và effort do owner chọn, file auth
  được chọn cho private home, cùng cho phép tiêu tối đa 6 invocation × 5 phút ghi vào một ledger.
- Repo GitHub sandbox (không phải `metronome`), quyền `gh` của orchestrator, người merge thủ công
  ba PR merge/squash/rebase, và kịch bản push/xóa source branch sau merge.

## Đối chiếu sau bàn giao prototype (2026-10-28)

**S0.1–S0.3 vẫn BLOCKED.** Lượt này kiểm lại bằng chứng local, không nạp profile, sửa kernel/sysctl,
gọi model, gọi GitHub hoặc thay điều kiện pass. Kết quả dưới đây không thay bảng lịch sử của host
bwrap 0.9.0 hoặc kết quả trước đó của worker Node 22.

| Nguồn / kiểm tra | Kết quả | Phạm vi |
| --- | --- | --- |
| Shell chạy quality gates: `node --version` | `v24.22.1`, khớp `.nvmrc` và package.json | Xác nhận bản Node cho lượt chạy mới; không sửa lại nguồn/version của bằng chứng cũ |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` | Cả bốn exit 0; default 48 file, 479 test pass, 0 pending/failed, duration 43,83 giây | Bằng chứng hồi quy trên Node 24; không thay outer proof hoặc smoke thật |
| JSON report `reports/vitest-default.json` | Suite runner-systemd có 1 assertion pass; sandbox-probe có 7 assertion pass | Runner với fake child và layout local; không chứng minh AppArmor child stack/native vendor/host triển khai |
| Probe đọc trực tiếp trong phiên công cụ: `/etc/os-release`, `bwrap --version` | Ubuntu 22.04.5, bubblewrap 0.6.1 | Ghi nhận môi trường probe hiện tại, không gộp với host lịch sử |
| `/sys/module/apparmor/parameters/enabled`, `/proc/self/attr/current` | `N`, nhãn `kernel` | Phiên probe không có AppArmor enforcement/child stack cần cho thiết kế hiện tại |
| `apparmor_parser --version` | `3.0.4` | Khác parser 4.0.1 ở host lịch sử |
| `apparmor_parser --skip-kernel-load --skip-cache deploy/apparmor/cusr-bwrap` | Exit 1, `Could not open 'abi/4.0': No such file or directory` | Profile hiện tại chưa compile được trong môi trường này; không chỉ thiếu file profile đã cài |
| Probe trực tiếp `systemctl --user is-system-running` trong phiên công cụ | Exit 1, `Failed to connect to bus: Operation not permitted` | Khác kết quả `running` người dùng cung cấp và assertion systemd trong lượt Vitest; quyền/bối cảnh truy cập bus cần được xác nhận trên terminal host, không kết luận user manager host bị tắt |

Để mở S0.1 theo thiết kế AppArmor lúc đó (trước ADR-0004), cần kiểm trên đúng host triển khai rằng kernel bật
AppArmor, userspace compile được profile ABI 4.0, và policy thực sự enforce trên process con cùng
audit capability denial. Chỉ cài file `/etc/apparmor.d/cusr-bwrap` không giải quyết các prerequisite
kernel/userspace còn thiếu này. Không bỏ child-stack/capability proof hoặc chọn external_verified
để vượt bước outer proof; nếu host hiện tại không đáp ứng, chủ dự án cần review môi trường triển
khai hoặc thiết kế cách ly thay thế trước T006. T007/T008 vẫn đợi credential, budget và sandbox
được cấp theo phạm vi đã chốt.

## Đánh giá lại cơ chế sandbox (2026-10-28)

Xem [đánh giá AppArmor và phạm vi sandbox của harness](sandbox-reassessment.md). Thí nghiệm mới
dùng chính sandbox builder hiện có, chỉ chạy fixture tạm: 5 role × 4 cách chạy (baseline,
nested bwrap, copied bwrap, raw userns), 20 lượt/360 kiểm tra đạt, mọi process mang nhãn
`unconfined`, không có child stack Cuesura. Đây là bằng chứng local về giới hạn truy cập được
thử, không phải pass S0.1, bằng chứng chống kernel exploit hoặc smoke harness thật.

Tại thời điểm đánh giá, đề nghị bỏ yêu cầu AppArmor 4 phổ quát, giữ OS boundary đã kiểm chứng, và
đối chiếu phạm vi native sandbox theo từng vendor/version; ADR/spec/plan/tasks lúc đó chưa thay đổi, gate giữ
BLOCKED. Probe mới nằm tại `scripts/spike-002/reassess-sandbox.ts`; typecheck/lint/default tests/
build đều exit 0, default 48 file/479 test pass. Đánh giá không nạp/gỡ policy hoặc gọi model/GitHub.
