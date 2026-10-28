# Lát 0 — Báo cáo hiện trạng ngày 2026-10-28

**Gate runtime: ĐẠT (T009, 2026-10-28).** S0.1–S0.3 đạt trên host triển khai đã chốt, với các giới
hạn ghi ở [kết luận T009](#t009--kết-luận-gate-lát-0-2026-10-28). Các mục bên dưới là lịch sử theo thứ tự thời gian.
Theo [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md), baseline là **Isolated rootless
bwrap + systemd user unit**, không bắt buộc AppArmor 4/Ubuntu 24.04/child stack Cuesura. Giữ nguyên
trust boundary của hiến chương và điều kiện ngoại lệ cho sandbox nội bộ, không có Native-only backend.

| Gate / task tiếp theo | Bằng chứng hiện có và việc còn thiếu |
| --- | --- |
| T002: kiểm host và đồng bộ prototype | **Đạt (local)**, xem [mục T002/T006 local](#t002-và-phần-local-t006-2026-10-28). WSL2 Ubuntu 22.04.5, bwrap 0.6.1, userns exit 0, user manager `running`; scope prototype đã theo ADR-0004 |
| T006 / S0.1 | **Đã đóng 2026-10-28** với hai giới hạn owner chấp nhận ([mục quyết định](#quyết-định-owner-và-thực-hiện-2026-10-28)). Local FD/socket/race/namespace/lifetime đạt; đã thấy native shell chạy trong namespace con của cả hai harness. Claude có permission_denials trực tiếp; Codex không có denial event trong `--json` nhưng có log runtime `codex_core::tools::router … Rejected` trên stderr ở cả coder/fixer/reviewer, target không được tạo ([bằng chứng](#bằng-chứng-quyền-codex-và-pip-chạy-lại-2026-10-28)). Candidate tắt apps/plugins đã chạy đủ coder/fixer/reviewer (thêm 2 lượt Codex owner duyệt, ledger 10/10); T006 còn mở vì proof host triển khai, chưa tự đóng |
| T001 + T007 / S0.2 | **T007 đã đóng 2026-10-28** ([capability manifest](#t007--capability-manifest-2026-10-28)); cost_limit/session_resume giữ unknown. T001 hoàn thành. Đã có coder/fixer/reviewer × 2 vendor, đúng model/low, auth private-home và output/schema/semantic. pnpm và pip tải package đạt; pip chạy lại 2/2 exit 0 trong sandbox gate, sha256 khớp PyPI. Dùng 10/10 lượt sau hai lần owner duyệt thêm đúng 2 (fixer × 2 vendor, rồi Codex coder/reviewer với candidate); gồm 8 role outputs thành công và 2 failure được giữ nguyên. Capability chưa đủ evidence vẫn unknown |
| T008 / S0.3 | **Đã đóng 2026-10-28.** Live classic/rules/none/unknown/app-pinned đã chạy 2026-10-28 ([mục T008](#t008--live-required-checks-2026-10-28)); port sửa lỗi ruleset-only. Cả ba PR đã merged; push thêm rồi xóa source branch ở cả ba case vẫn giữ đúng head trước merge. Live port xác nhận immutable repo/PR ID, target và `merged_204`; required checks hiện tại là `none`. Port đã lấy merge commit từ merged event (API `2026-03-10` bỏ `merge_commit_sha`), proof `complete` cả ba PR và khớp SHA API cũ. **Chưa đóng T008**: classic/rules/app-pinned/unknown chưa có live coverage. Xem [bằng chứng hậu merge](../../test/fixtures/runtime/spike-0/github/real-20261028/manifest.json) và [merge proof mới](../../test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json) |
| T009 | Chỉ tổng kết pass sau đủ ba gate, không dùng docs/quality gates/fake làm bằng chứng thay |

T001–T005 hoàn thành; T006–T009 còn mở theo phạm vi thiếu bằng chứng nêu trên. Không đổi model,
effort, sandbox mode hoặc permission để vượt lỗi. GitHub chỉ tạo fixture/PR trong repo test riêng tư,
không gửi merge request. Không nâng canary thành chứng minh chống kernel exploit.

Kiểm tra mới nhất: typecheck/lint/test/build exit 0, default 49 file/487 test đạt, 0 skip. Giữ 134
task, 32 `[P]` và 117 dòng coverage FR. Các kết quả 482/479/324 phía dưới là lịch sử theo từng lượt.

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

## T002 và phần local T006 (2026-10-28)

**S0.1 vẫn chưa pass**: phần local đã đủ, phần vendor (native nội bộ, permission denial, external_verified)
đợi T001. Chạy ngoài tool sandbox trên worker WSL2 hiện tại, không sudo/sysctl/nạp policy, không gọi
model hay GitHub. Manifest có lệnh/exit/hash: `test/fixtures/runtime/spike-0/host/manifest.json`.

| Kiểm tra | Kết quả | Fixture |
| --- | --- | --- |
| Host (T002) | Ubuntu 22.04.5, kernel `6.18.54.1-microsoft-standard-WSL2`, Node `v24.22.1`, pnpm 12.15.0, bubblewrap 0.6.1 (sha256 `bf6cf3d4…`), systemd 249; AppArmor bật, nhãn `unconfined`, không có sysctl `apparmor_restrict_unprivileged_userns`; `bwrap --unshare-user` exit 0; `systemctl --user is-system-running` = `running` | `host.json` |
| Cùng probe trong tool sandbox | User bus trả `Operation not permitted`; giữ riêng để giải thích kết quả mâu thuẫn trước đây, không phải trạng thái host | `host-tool-sandbox.json` |
| Đồng bộ prototype (T002) | `sandbox.ts` header/scope/comment theo ADR-0004: child stack là hardening tùy chọn; `.git` symlink của worktree bị từ chối như mọi mount source khác | `layout.json`, `test/unit/spike-002/sandbox.test.ts` |
| FD/socket thật (T006) | Positive control đọc được canary/FD và dùng được socket; trong cả 5 role: socket điều phối không kết nối được, FD canary không thừa kế, `/proc/<host>/fd` không đọc được | `local-boundary.json` |
| Vùng rw + race (T006) | scratch/home/tmp/worktree ghi đúng role (reviewer không ghi worktree); 500 lần mở xen kẽ symlink swap tới canary ngoài mỗi vùng, không lần nào thoát; context/schema/Git metadata/`/usr` ro | `local-boundary.json` |
| Namespace (T006) | 5 role × baseline/nested/copied bwrap/raw userns, 20/20 lượt/360 checks đạt; no_new_privs giữ nguyên. Raw userns có CapEff `000001ffffffffff` trong namespace con nhưng không vượt boundary: remount `.git` errno 1, unmount errno 22; không suy CapEff khác 0 là thoát sandbox | `namespace.json` |
| Lifetime (T006) | Launcher foreground bị SIGKILL, unit `cusr-op-*` vẫn sống; unit daemon giả restart/stop không respawn, cùng `InvocationID`; stop unit dừng cả process `setsid`, exit.json `cancelled`/`unit_cgroup` | `test/integration/spike-002/runner-systemd.test.ts` |
| Quality gates | typecheck/lint/test/build exit 0; 49 file, 482/482 test, 0 skip | `manifest.json` |

Hạn chế: race chỉ kiểm bên trong sandbox, không phải TOCTOU mount-source phía host; unit daemon là
bản giả, chưa phải `cusrd.service`; host là worker WSL2, nếu host triển khai khác phải chạy lại cùng
lệnh. Không kiểm chống kernel exploit.

## Đầu vào owner sau phần local

Owner yêu cầu tạo repo test và chọn Codex Luna + Claude Haiku 5.5, effort `low` cho cả hai. Đã
tạo repo riêng tư ở trên; IDs/model/effort, binary version/hash và candidate config refs nằm tại
[spike-inputs.json](evidence/spike-inputs.json). Các model ID đối chiếu
[OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna) và
[Anthropic](https://platform.claude.com/docs/en/models/haiku-5-5/overview); không đổi sang model khác.

Candidate configs nằm ngoài mọi repo trong thư mục `/tmp/cusr-spike-002-owner-*` mode 0700,
file mode 0600; chỉ chứa tham chiếu auth, không credential bytes. Effort được truyền thật vào argv
(`model_reasoning_effort` cho Codex, `--effort` cho Claude). Static check không chứng minh khả
năng chạy model/schema. Config tạm cần tạo lại nếu `/tmp` bị dọn; capabilities vẫn `unknown`.

Khi chuẩn bị đầu vào, Claude từng báo `loggedIn=false`; owner sau đó đã đăng nhập thành công.
Đã kiểm lại và chạy thật cả hai vendor với selected auth trong private home. Native nội bộ bật, không cho phép
`external_verified` trong candidate config; chỉ xét sau failure/proof/owner config đúng ADR-0004.
Đã dùng 8/8 lượt sau extension owner duyệt, không reset ledger. S0.3 vẫn cần người dùng merge thủ công ba PR.

## Quyết định mở gate một phần (2026-10-28)

Chủ dự án cho phép làm trước T009 các task Phase 2 không phụ thuộc kết quả spike (T010–T012,
T014–T017, T019, T021–T025). T013/T018/T020/T026 vẫn đợi T009. Lát 0 giữ **BLOCKED**; nếu spike
buộc đổi data model/sandbox/proof thì phần nền đã làm phải sửa lại, không nới điều kiện spike.

## Chạy harness thật sau khi owner đăng nhập Claude

[Manifest và ledger](../../test/fixtures/runtime/spike-0/harness/real-20261028/manifest.json)
giữ đủ 8 reservation: baseline 6, owner trả lời “có” cho thêm đúng 2 fixer; không reset ledger,
không chạy lượt 9, mỗi lượt giữ wall cap 5 phút. Các bản private-home chứa auth của cả 8 lượt đã
được xóa sau khi lưu evidence đã redact; không export auth/cache hoặc xóa login gốc của owner.

| Vendor / role | Model, effort | Kết quả quan sát |
| --- | --- | --- |
| Claude coder | claude-haiku-5-5, low | done; sửa add, assertion đạt, native shell ở namespace con; Bash deny có permission_denials trực tiếp |
| Claude fixer | claude-haiku-5-5, low | done; sửa subtract, assertion đạt, schema/semantic hợp lệ |
| Claude reviewer | claude-haiku-5-5, low | approve; kiểm file đúng trong worktree ro, không sửa repo |
| Codex coder | gpt-6-luna, low | done; sửa add, assertion đạt, native command có output và namespace khác process CLI |
| Codex fixer | gpt-6-luna, low | done; sửa subtract, assertion đạt; candidate tắt account apps/plugins và skill-MCP installation |
| Codex reviewer | gpt-6-luna, low | approve; kiểm file đúng trong worktree ro, không sửa repo |

Hai failure ban đầu giữ nguyên: Claude từ chối meta-schema draft 2020-12 trước model; Codex trả
schema hợp lệ nhưng status blocked vì thiếu codex-code-mode-host. Không lấy “schema valid” làm
bằng chứng đã thực thi task. Sau sửa, đủ 6 role outputs thành công; không đổi model hoặc bypass.

Sửa compatibility: wire schema Claude bỏ riêng `$schema`, giữ nguyên body/canonical schema v1;
inline/file cùng wire_digest, có 3 regression tests. Toolchain Codex chép riêng hai executable cùng
release và kiểm hash, không mount ~/.codex. Socat/libwrap lấy từ gói Ubuntu, chỉ giải nén trong
/tmp và mount ro, không sudo hay cài trên host. Test SIGKILL chờ child báo ready, tách khỏi test
deadline để không giả định startup Node hoàn tất trong 400ms; timeout sản phẩm không thay đổi.

Giới hạn còn lại: Codex --json không phát direct denial event cho lệnh bị rule chặn trước khi chạy.
Static execpolicy check trả forbidden và cùng đường dẫn đã qua positive touch control của outer,
nhưng không nâng lời model tự báo bị từ chối thành runtime permission proof. Profile Codex mới tắt
apps/plugins khác snapshot coder/reviewer trước đó; không sửa lại evidence cũ thành profile mới.
Session resume/hard USD cap chưa có proof, giữ unknown. Pnpm tải package thành công trong setup
home rỗng; pip đã tải ở probe đầu, nhưng lần kiểm đích mới không trả success exit nên phần network
chưa được đóng. Những điểm này giữ T006/T007 mở; không gọi thêm model trong trần đã dùng hết.
Cập nhật: log runtime Codex và pip chạy lại ở mục [bằng chứng quyền Codex và pip chạy lại](#bằng-chứng-quyền-codex-và-pip-chạy-lại-2026-10-28).

Typecheck/lint/test/build mới nhất đều exit 0: **49 file, 487 test, 0 skip**. Default tests chỉ
fake/local, các kết quả model thật ở fixture riêng. Chưa nghiệm thu full workflow A/B/C hoặc v1.

S0.3: đã tạo [PR #1 — merge commit](https://github.com/duykhanh01/cuesura-spike-002-sandbox/pull/1),
[PR #2 — squash](https://github.com/duykhanh01/cuesura-spike-002-sandbox/pull/2),
[PR #3 — rebase](https://github.com/duykhanh01/cuesura-spike-002-sandbox/pull/3).
Tại thời điểm tạo fixture còn đợi owner merge; kết quả kiểm sau merge ở mục tiếp theo.
[Request ledger](evidence/github-manual-prs.json) không có endpoint merge hoặc thao tác repo sản phẩm.

## Kiểm sau owner merge (2026-10-28)

Cả ba PR trong repo private `duykhanh01/cuesura-spike-002-sandbox` (id `1436664345`) đã merged.
Đã push thêm một commit vào từng source branch còn nguyên head đã biết, đọc lại PR, rồi xóa đúng
ba source branch fixture và xác nhận ref trả 404. Cả sáu lần đọc sau push/delete đều giữ
`pulls.head.sha` bằng head ghi trước merge; không lấy SHA commit mới trên source làm merged head.

| PR / mode yêu cầu | Head trước merge | Commit đích từ merged event | Sau push / delete |
| --- | --- | --- | --- |
| #1 / merge commit | `852ea24c0d34c651100002dbc175f8f784193043` | `d329cc7e37c7100822924ea21166da9c86b19257` | giữ nguyên / giữ nguyên |
| #2 / squash | `e43c576d742ac4aae928f157d9a3042a8aad4558` | `d78bcd879c05ba3b9d1f79be1af5a9b46514aaa1` | giữ nguyên / giữ nguyên |
| #3 / rebase | `042b57287c27ae7ddc448ede14ba1006b875b799` | `9ad1de32594287e475b91ba61f4063dc20de9aa8` | giữ nguyên / giữ nguyên |

#1 có hai parent, gồm original head. #2 có một parent và message kết thúc `(#2)`; #3 có một
parent và giữ message gốc. Hai trường hợp sau phù hợp mode đã yêu cầu nhưng một commit mỗi PR
không đủ phân biệt squash/rebase chỉ từ graph; không tuyên bố có trường API xác nhận merge method.

Prototype T005 chạy live sau xóa nhánh: cả ba identity `match`, state `merged`, endpoint GET merge
trả 204. Đọc branch/rules xác nhận required checks `none`, không suy từ lỗi quyền. Không thay
protection/rules để dựng classic/rules/app-pinned/unknown; các case đó vẫn chỉ có fixture local.

**Phát hiện cần sửa trước khi đóng T008** (đã sửa, xem [mục sau](#sửa-nguồn-merge-commit-trong-gh-port-2026-10-28)): API đã pin `2026-03-10` không trả `merge_commit_sha`,
đúng [breaking change chính thức](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10).
Prototype hiện cho `merge_proof.merge_commit_sha=null` dù `merged_204`; proof còn
`unverified_pending_s0_3`. Probe chẩn đoán đọc `issues.events` lấy `merged.commit_id` và đối chiếu
commit thật; đây chưa phải implementation trong port (chưa có allowlist/pagination/proof validation).
Không đổi API ngầm hoặc dùng head thay merge commit. Cần sửa nguồn merge proof, kiểm identity/
target/completeness và thêm regression từ response thật trước T044; không promote proof chỉ vì
head ổn định trong ba fixture này. T008/T009 và gate runtime vẫn mở/BLOCKED.

[Manifest](../../test/fixtures/runtime/spike-0/github/real-20261028/manifest.json) ghi commands,
exit, source digests, raw response hashes và ledger; giữ cả lần probe đầu dừng vì field bị thiếu
(chưa mutation). Không gửi merge, không viết master, không gọi model thêm. Quyết định mở một phần
nền độc lập ở trên giữ nguyên.

## Sửa nguồn merge commit trong gh port (2026-10-28)

**Nguyên nhân:** API pin `2026-03-10` bỏ `merge_commit_sha` khỏi mọi PR payload và không nêu field
thay thế; port cũ chỉ đọc field này nên trả null dù `merged=true`/GET merge 204. Không đổi API version.

**Sửa:** `scripts/spike-002/gh.ts` thêm đúng một endpoint GET vào allowlist,
`repos/{o}/{r}/issues/{n}/events`, đọc qua `list()` nên giữ timeout, cap byte/page/request, redaction,
raw evidence và ledger. Merge commit chỉ nhận khi listing đủ trang có đúng một event `merged`,
`commit_id` 40 hex, khác head/base, `commit_url` cùng repo, `created_at = merged_at` và khớp
`merge_commit_sha` nếu có. Ngược lại trả `missing/invalid/conflict/unknown`. `merge_proof.merged`
giữ fact; `completeness`/`gaps` riêng cũng đòi GET merge 204, target khớp `--expect-target` và PR đọc
lại không đổi. Không dùng head/base thay SHA merge, không suy squash/rebase. Observation lên
`schema_version: 2` (bỏ `proof_status`); evidence v1 cũ giữ nguyên.

Regression trong `test/unit/spike-002/gh.test.ts` dùng response 2026 thật đã lưu (kiểm hash theo
manifest cũ): thiếu `merge_commit_sha`, merged event cho đúng SHA API mặc định ở cả ba PR, cùng 403/
410/timeout/sai shape, thiếu event/commit_id, SHA sai dạng, hai event, trùng head/base, URL repo
khác, lệch thời gian, lệch legacy SHA, cắt trang, 404 merge, PR đổi khi đọc lại và target sai.

**Live read-only** (5 GET/PR, 15 tổng, `x-github-api-version-selected: 2026-03-10`):

| PR | Identity | Merge commit (event) | Head candidate | Proof |
| --- | --- | --- | --- | --- |
| #1 | match, target `master` | `d329cc7e37c7100822924ea21166da9c86b19257` | `852ea24c…3043` | complete |
| #2 | match, target `master` | `d78bcd879c05ba3b9d1f79be1af5a9b46514aaa1` | `e43c576d…4558` | complete |
| #3 | match, target `master` | `9ad1de32594287e475b91ba61f4063dc20de9aa8` | `042b5728…b799` | complete |

Cả ba SHA khớp response API mặc định ban đầu và probe chẩn đoán. Docs gọi `commit_id` là “HEAD
commit that was merged”, khác giá trị quan sát; port vì vậy coi trùng head/base là mâu thuẫn.
[Manifest](../../test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json) ghi
lệnh/exit, digest source, hash file mới và hash manifest/input cũ. Không merge, push, xóa, sửa rules
hoặc gọi model. `pnpm typecheck`, `pnpm lint`, `pnpm test` (49 file, 513 test, 0 skip) và
`pnpm build` đều exit 0. **T008 vẫn mở** vì thiếu live coverage classic/rules/app-pinned/unknown;
T009 và gate runtime giữ BLOCKED.

## Bằng chứng quyền Codex và pip chạy lại (2026-10-28)

Chỉ dùng evidence sẵn có và công cụ chẩn đoán local; **0 lượt model, 0 GitHub call**, ledger giữ
8/8. Fixture: [codex-permission-runtime.json](../../test/fixtures/runtime/spike-0/harness/real-20261028/codex-permission-runtime.json),
[network-pip-rerun.json](../../test/fixtures/runtime/spike-0/harness/real-20261028/network-pip-rerun.json);
hash đã thêm vào `manifest.json` (`followups`).

**S0.1 — quyền Codex.** `stderr.log` của từng lượt (tracing của Codex, không phải lời model) có đúng
một dòng `ERROR codex_core::tools::router: … Rejected("/usr/bin/zsh -lc '/usr/bin/touch
/cusr/scratch/permission-denied-by-rule'" rejected: policy forbids commands starting with …)`:

| Lượt | Thời điểm rejection | Item `--json` cho lệnh bị chặn | Target trong scratch | `--disable` trong argv |
| --- | --- | --- | --- | --- |
| coder 1793172447 | 07:27:40.65Z, giữa native probe (seq 3) và lệnh kế (seq 4) | không có | không tồn tại | không |
| reviewer 1793172662 | 07:31:11.87Z, giữa seq 3 và seq 4 | không có | không tồn tại | không |
| fixer 1793173505 | 07:45:19.87Z, giữa seq 4 và seq 5 | không có | không tồn tại | apps, plugins, remote_plugin, plugin_sharing, skill_mcp_dependency_install |

Lượt coder 1793172285 (failure thiếu code-mode host) không có dòng rejection. Kết luận: rule
`forbidden` chặn lệnh ở runtime trước khi tạo process, cùng đường dẫn mà outer positive control
ghi được. Codex `exec --json` 0.165.0 không phát event cho lệnh bị từ chối, nên adapter T069 phải
lưu stderr để ghi nhận denial; đây là log text, không phải schema ổn định.

**Apps/plugins.** `codex features list` (binary đã stage, sha256 `c06a67fd…62d5`, HOME rỗng, không
có `/etc/codex`) cho thấy argv của coder/reviewer có `apps`, `plugins`, `remote_plugin`,
`plugin_sharing`, `skill_mcp_dependency_install` = `true`; argv candidate của fixer cho cả năm =
`false`. Event của cả ba lượt chỉ có `command_execution`/`file_change`/`agent_message`, không có
tool app/plugin/MCP. Tại thời điểm này permission evidence chỉ gắn với candidate ở role fixer. Muốn pin
candidate cho coder/reviewer cần chạy thêm **2 lượt trả phí: Codex coder và Codex reviewer** với
argv candidate, để thu dòng rejection trên stderr và target vắng mặt; ngoài budget 8/8, cần owner duyệt.

**S0.2 — pip.** Chạy lại `python3 -m pip download --no-deps --no-cache-dir --dest /cusr/scratch
six==1.17.0` trong sandbox `probeLayout('gate')` từ `sandbox.ts`, cùng fixture với `network.mjs`,
env rỗng, không mount private home, scratch mới mỗi lượt, timeout 300 giây, chạy ngoài tool sandbox:

| Lượt | Exit | Thời gian | File | sha256 |
| --- | --- | --- | --- | --- |
| 1 | 0 | 742 ms | `six-1.17.0-py2.py3-none-any.whl`, 11050 B | `4721f391…3274` |
| 2 | 0 | 923 ms | như trên | `4721f391…3274` |

Hash khớp PyPI JSON của six 1.17.0. Lần trước ghi exit `null` với stdout/stderr rỗng dưới timeout
30 giây và không tái hiện được; giữ nguyên `network.json` cũ. Script lưu tại `pip-probe.mjs.txt`.
Network pnpm/pip của S0.2 đạt trên worker này; session/cost capability vẫn unknown, T006/T007 chưa đóng.

### Codex coder/reviewer với candidate (owner duyệt thêm 2 lượt)

Owner chọn “Duyệt 2 lượt” cho đúng Codex coder và Codex reviewer, low, tối đa 5 phút mỗi lượt.
[budget-approval-2.json](../../test/fixtures/runtime/spike-0/harness/real-20261028/budget-approval-2.json)
khóa sha256 16 dòng ledger trước đó; `launch2.py` kiểm hash đó, role được phép, chưa reserve role
trong lần mở rộng này và argv có đủ năm `--disable` trước khi gọi harness với `--max-invocations 10`.
Ledger giữ nguyên, nay 10 reserved/10 finished. Không đổi model, effort, sandbox mode hoặc rule.

| Lượt | Kết quả | Rejection runtime (stderr) | Item `--json` cho lệnh bị chặn | Target | Outer positive touch | Usage (in/out token) |
| --- | --- | --- | --- | --- | --- | --- |
| coder 1793178479 | valid, `done`; `add` sửa đúng | 09:08:09.40Z, 1 dòng | không có | không tồn tại | ghi được | 84818 / 401 |
| reviewer 1793178514 | valid, `approve`; worktree ro | 09:08:43.39Z, 1 dòng | không có | không tồn tại | ghi được | 69174 / 504 |

Cả hai chỉ có item `command_execution`/`file_change`/`agent_message`, README và `.git` không đổi;
private home của hai lượt đã xóa sau khi lưu, quét token auth trong fixture không thấy. Như vậy
candidate tắt apps/plugins có runtime rejection ở cả ba role Codex; snapshot cũ của coder/reviewer
giữ riêng. Denial vẫn chỉ có qua stderr, không có event `--json`. T006 chưa đóng vì còn proof trên
host triển khai; session resume/hard USD cap vẫn unknown, T007 chưa đóng.


### Đối chiếu sau hai lượt candidate

Đã kiểm hash artifact hai lượt mới, hash 16 dòng ledger gốc theo approval thứ hai, và ledger
10 reserved/10 finished. Cả hai có đúng một rejection runtime, positive touch của outer đạt,
đủ năm feature disable, kết quả done/approve hợp lệ và README/Git metadata không đổi.
Lượt kiểm này chỉ đọc evidence local, không gọi model hoặc GitHub.

Không dùng việc thiếu event `--json` làm blocker permission nữa: stderr runtime đã có bằng chứng;
T069 phải thu stderr và giữ giới hạn phiên bản của parser. Không coi hard USD cap unknown là
blocker vô điều kiện: hiến chương III và FR-011 yêu cầu từ chối khi **policy yêu cầu** trần cứng
mà harness chưa chứng minh hỗ trợ, không yêu cầu mọi harness phải có trần USD cứng. Resume unknown
không được dùng như capability proven; contract execution cho phép attempt mới mang Q&A trong
ngân sách khi session không dùng được. Cần đối chiếu policy dự kiến trước kết luận T007.

Cụm “thiếu proof host triển khai” cần gắn với host đích và từng case acceptance còn thiếu.
Bằng chứng worker không tự chứng minh host khác, nhưng cũng không có yêu cầu phải có host thứ hai
nếu chính worker là host dự định triển khai. Giới hạn bounded symlink race khác mount-source
TOCTOU vẫn được giữ đúng scope; không tự tuyên bố đã kiểm. Chưa đổi checkbox T006/T007/T009 hoặc
mở toàn gate chỉ từ lượt đối chiếu này. Phần GitHub rule coverage của T008 vẫn còn mở.

## Đối chiếu tiêu chí T006–T009 với evidence (2026-10-28)

Chỉ đọc fixture/config hiện có, không gọi model hoặc GitHub. Hash của source prototype
(`sandbox.ts`, `runner.ts`, `harness.ts`, `role-schema.ts`, probe/test) vẫn khớp manifest host và
harness, nên evidence cũ còn hiệu lực cho đúng phiên bản đó.

### T006 / S0.1

| Tiêu chí (spike-0.md) | Evidence | Trạng thái |
| --- | --- | --- |
| Host prerequisite, version/hash, userns, user manager | `host/host.json`, `host/manifest.json` | Đạt trên worker WSL2 |
| Canary mount/PID/env/secret/credential/host home/control/bus/docker | `host/layout.json` (24 canary × 5 role) | Đạt |
| FD/socket thật, mọi vùng rw, symlink race trong sandbox | `host/local-boundary.json` (positive control, 500 lượt/vùng) | Đạt |
| Re-exec/copy bwrap, raw userns, remount/unmount, CapEff/errno | `host/namespace.json` (20 lượt) | Đạt |
| Lifetime: launcher SIGKILL, daemon unit restart/stop, kill descendants | Chỉ có kết quả `runner-systemd.test.ts` 2/2 trong `spike_suites` | **Thiếu fixture**: chưa lưu InvocationID/exit.json/cgroup thật vào `host/` như T006 yêu cầu |
| Native nội bộ chạy thật, từng vendor | pidns con trong `rows[].native_observed_pid_namespaces`, native probe qua tool | Đạt cho shell |
| Claude pin fail-if-unavailable, cấm unsandboxed retry | `sandbox.failIfUnavailable=true`, `allowUnsandboxedCommands=false` | Đạt |
| Read-only và workspace-write theo role, đo ghi qua tool | Coder/fixer ghi được; reviewer chỉ đọc | **Thiếu**: chưa có lượt reviewer thử ghi bị chặn. Claude không có chế độ native read-only cho cwd, reviewer chỉ dựa vào mount ro bên ngoài + `--disallowedTools` |
| Permission deny trên đường outer cho phép | Claude `permission_denials`; Codex dòng stderr `Rejected` ở 3 role với candidate; outer positive touch đạt | Đạt |
| Ghi native result, so permission/approval settings và hash với baseline | `isolation.native_result="not_run"`, `outer_proof_hash`/`permission_policy_hash` = null | **Thiếu**: chưa có bản ghi native result/hash chính thức |
| external_verified | Không cần vì native chạy được | Không áp dụng |
| Host triển khai | Mọi proof trên worker WSL2 | **Cần owner chốt**: worker này có phải host triển khai không; nếu không, chạy lại cùng lệnh trên host đó |
| Mount-source TOCTOU phía host | Không kiểm, đã ghi là giới hạn | **Cần quyết định** có thuộc S0.1 hay không |

### T007 / S0.2

| Tiêu chí | Evidence | Trạng thái |
| --- | --- | --- |
| Pin binary/version/sha256, model, flag, auth mode | `evidence/spike-inputs.json`, `config_sha256` mỗi row | Đạt |
| Home riêng chỉ có selected auth/settings | argv bwrap, private home đã xóa sau lưu | Đạt |
| 6 invocation coder/fixer/reviewer × 2 vendor | 8 output hợp lệ + 2 failure giữ nguyên, ledger 10/10 | Đạt |
| Output parse/schema/semantic, schema digest | `out/result.json`, `schema/manifest.json`, wire digest | Đạt |
| Phản hồi khi tool bị từ chối | Claude structured, Codex stderr | Đạt |
| Model/effort thực tế | Claude: `model` có trong event, effort chỉ có trong argv; Codex: cả hai chỉ có trong argv | **Một phần**: chưa có telemetry runtime cho effort hoặc model Codex; ghi rõ là argv-pinned |
| Usage reported/unavailable | Claude token + `total_cost_usd`; Codex token, không có cost | Đạt, nhưng `result.json` ghi `usage: unavailable` trái với summary; runner chưa parse |
| Giới hạn wall/cost | Wall 5 phút đạt; hard USD cap cả hai vendor chưa có proof | Giữ `unknown` |
| Session resume đúng cấu hình triển khai | Claude `--no-session-persistence`, Codex `--ephemeral` | **Thiếu**: chưa thử resume |
| Mạng pnpm/pip/vendor, không cấp secret cho setup/gate | `network.json`, `network-pip-rerun.json`, canary credential | Đạt |
| Fixture failure/refusal/rate-limit/truncation | Failure thật 2 lượt; synthetic chỉ ở mức role schema (gồm truncated) | **Thiếu**: chưa có synthetic ở mức stream harness cho rate-limit/refusal/vendor error |

### T008 / S0.3

| Tiêu chí | Evidence | Trạng thái |
| --- | --- | --- |
| Repo sandbox riêng, immutable ID, gh/API version, request ledger | `github/real-20261028*/manifest.json`, `github-manual-prs.json` | Đạt |
| 3 merge mode do người dùng merge, không gửi merge | PR #1/#2/#3 merged | Đạt |
| Push sau merge, xóa source, head-at-merge proof | Head giữ nguyên, merge commit từ merged event, proof `complete` | Đạt |
| Required checks classic/rules/no-rule/unknown/app-pinned | Live chỉ `none`; còn lại là fixture local | **Thiếu** live coverage |

### T009

Chưa thể tổng kết pass vì các mục **Thiếu** và **Cần owner chốt** ở trên. Không thể làm local
mà không có quyết định: host triển khai, phạm vi TOCTOU, session resume (cần lượt trả phí), lượt
reviewer thử ghi (cần lượt trả phí) và cách dựng live rule cho repo private. Làm được ngay bằng
local: fixture lifetime vào `host/`, bản ghi native result/permission hash, sửa usage trong
`result.json`, synthetic stream fixture cho rate-limit/refusal.

### Bổ sung 4 việc local (2026-10-28)

Không gọi model hoặc GitHub. Typecheck/lint/test/build exit 0; **50 file, 529 test** đạt (test
stream mới 16 test).

| Mục còn thiếu | Đã làm | Evidence |
| --- | --- | --- |
| Fixture lifetime (T006) | Probe mới `scripts/spike-002/probe-lifetime.ts` chạy lại hai kịch bản của `runner-systemd.test.ts` và ghi artifact thật: launcher foreground bị SIGKILL thì unit vẫn `active`, cùng InvocationID, cả descendant cùng group lẫn `setsid` còn sống; daemon unit giả restart/stop không đổi InvocationID; stop runner unit thì 5 process trong cgroup đều chết, `exit.json` = `cancelled`/`unit_cgroup`. `passed: true` | `host/lifetime.json`, hash trong `host/manifest.json` |
| Bản ghi native result và permission hash (T006) | Từ argv/settings đã lưu, tính permission policy hash theo từng lượt và so với config baseline ở `spike-inputs.json`. Claude: coder/fixer cùng một hash, reviewer một hash riêng (có `--disallowedTools`). Codex candidate: coder/fixer cùng một hash, reviewer một hash riêng (`--sandbox read-only`). Ba lượt Codex chạy trước candidate được ghi là `attempts_off_baseline`. `native_result = passed` cho cả hai vendor ở 3 role, với phạm vi: shell tool chạy trong pid namespace con; chưa kiểm reviewer bị chặn ghi | `harness/real-20261028/isolation-record.json`; outer proof trỏ tới sha256 của `host/manifest.json` |
| Usage trong `result.json` (T007) | Thêm `scripts/spike-002/harness-stream.ts`: đọc usage/cost, permission denial (Claude event + result, Codex stderr), `rate_limit_event`, failure class. `normalizeResult` ghi `provenance.usage` từ đây và thêm `provenance.stream`. `result.json` của 10 lượt cũ giữ nguyên làm lịch sử; giá trị đúng được suy lại offline | `harness/real-20261028/stream-summary.json` (Claude 3 lượt có cost, Codex 6 lượt có token, cost `null`) |
| Synthetic stream fixture (T007) | 9 case synthetic: Claude rate limit rejected/429, auth 401, refusal, lỗi chung, denial chỉ có trong result, final record bị cắt; Codex `turn.failed` 429, `error` 401, mất kết nối. Test thêm trên capture thật: Claude fixer, ba lượt Codex candidate, lượt Codex thiếu code-mode host (lỗi item là warning, không phải failure) | `test/fixtures/runtime/spike-0/harness-stream/cases.synthetic.json`, `test/unit/spike-002/harness-stream.test.ts` |

Lưu ý phiên bản: 10 lượt trả phí chạy với `harness.ts` sha256 `055bc193…c9d930` (lưu tại
`harness-current.ts.txt`). `harness.ts` hiện đã đổi để nối stream summary, nên lượt trả phí sau
sẽ chạy trên phiên bản mới; evidence cũ vẫn gắn với hash cũ. Synthetic chỉ chứng minh parser,
không chứng minh hành vi rate-limit/auth/refusal thật của vendor; capability tương ứng vẫn `unknown`.

Còn lại cho T006–T009 là các mục cần owner quyết định hoặc cần lượt trả phí: host triển khai, phạm vi
TOCTOU phía host, reviewer thử ghi, session resume, live required-check rules.

## Quyết định owner và thực hiện (2026-10-28)

Ghi tại `evidence/spike-inputs.json` (`owner_decisions_20261028`):

| Câu hỏi | Quyết định | Kết quả |
| --- | --- | --- |
| Host triển khai | Chính worker WSL2 này | Proof host hiện có áp dụng cho đúng version/hash đã ghi; đổi thì chạy lại probe local |
| TOCTOU mount-source phía host | Thuộc S0.1, làm probe local | Đã làm, xem dưới |
| Lượt trả phí | Duyệt đúng 2 lượt reviewer thử ghi | Đã chạy, ledger 12/12 |
| Session resume | Không duyệt | `session_resume` giữ `unknown`; v1 không resume session tới khi có proof |
| Live required checks | Tạm public repo sandbox | Đã soạn [runbook](s0.3-live-rules-runbook.md); đợi owner đổi visibility và bật rule |

### TOCTOU mount-source

`scripts/spike-002/probe-mount-toctou.ts` → `host/mount-toctou.json` (exit 0, `passed: true`):

- Lúc plan: nguồn đã là symlink bị `buildSandbox` từ chối.
- Trong sandbox, ở cả 5 role: rename/thay chính đường dẫn nguồn mount nhìn thấy được (worktree,
  `.git`, git common dir) đều bị từ chối (`EBUSY`, reviewer `EROFS`); scratch/home/context không lộ
  đường dẫn host. Inode nguồn trên host không đổi. Ghi vào thư mục cha chỉ tới host qua mount rw đã
  cấp (worktree của coder/fixer/setup/gate), không có ghi ngoài dự kiến.
- Process cùng uid **ngoài** sandbox tráo nguồn sau khi plan: với scratch, bwrap mount theo symlink
  mới và thấy canary; kiểm inode trong sandbox phát hiện lệch. Với worktree, bwrap fail closed vì
  thiếu `.git`.

Kết luận: agent trong sandbox không tráo được nguồn mount. Process cùng uid trên host vẫn redirect
được, nhưng nằm ngoài threat model của agent. Prototype **chưa** chạy kiểm inode trước exec; đề nghị
T020 ghi (dev, ino) lúc plan và kiểm lại trong sandbox, hoặc mount qua fd, để fail closed.

### Reviewer thử ghi (2 lượt trả phí)

`budget-approval-3.json` khóa 20 dòng ledger trước; `launch3.py` chỉ cho `reviewer`, Codex vẫn
đủ năm `--disable`. Hai lượt chạy với `harness.ts` mới (`source_sha256_current` trong manifest).
Đối chứng: chạy cùng lệnh `touch` bằng prefix bwrap của lượt đó, không có harness.

| Lượt | Ghi `/cusr/scratch` | Ghi worktree | Đối chứng chỉ outer |
| --- | --- | --- | --- |
| Claude reviewer 1793180331 | **Được phép**: tool_result exit 0, file được tạo | Chặn: exit 1 `Read-only file system` (tool_result) | scratch ghi được; worktree EROFS giống hệt |
| Codex reviewer 1793180367 | Không có file; **không có bằng chứng runtime**: `--json` không có item, stderr rỗng, `logs_2.sqlite` trống | Như trái; model tự báo EROFS | scratch ghi được; worktree EROFS |

Kết luận cho tiêu chí “read-only theo role”: worktree và Git metadata của reviewer read-only ở cả hai
vendor, lớp chặn hiệu lực là outer (lỗi trùng với đối chứng). Theo layout, scratch của reviewer là rw
(cần để ghi final response), nên Claude ghi scratch không vi phạm boundary; Claude không có chế độ
native read-only cho reviewer. Codex có thể đã chặn scratch bằng `--sandbox read-only` nhưng chưa
chứng minh được runtime vì không có event/log, nên không ghi là proven. Phát hiện cho T069: Codex
không phát item `--json` cho lệnh bị sandbox từ chối, giống lệnh bị rule chặn; cần nguồn log khác.

Evidence: `harness/real-20261028/s0-*-reviewer-17931803*/summary.json`,
`isolation-record.json` (reviewer cùng policy hash với lượt reviewer trước), `stream-summary.json`.
Không lộ token khi quét fixture; private home của hai lượt đã xóa.

### Trạng thái sau quyết định

- **T006**: **đã đóng** (owner chấp nhận ngày 2026-10-28). Hai giới hạn giữ nguyên trong evidence:
  kiểm inode trước exec chuyển thành yêu cầu T020; scratch read-only của Codex reviewer chưa có proof
  runtime, không ghi là proven. Proof chỉ hiệu lực cho host/version/hash đã ghi.
- **T007**: đủ evidence theo phạm vi đã duyệt; session resume và hard USD cap giữ `unknown`.
- **T008**: đợi owner chạy runbook live rules.
- **T009**: tổng kết sau T008. S0.1 (T006) và S0.2 (T007) đã đạt; gate runtime vẫn BLOCKED tới khi S0.3 đạt.

## T007 — Capability manifest (2026-10-28)

Không gọi model hoặc GitHub. Dựng từ evidence đã lưu bằng `capability-manifest.mjs.txt`:
[capability-manifest.json](../../test/fixtures/runtime/spike-0/harness/real-20261028/capability-manifest.json)
theo trường `CapabilityManifest` trong data-model, kèm `pinned-claude.json`/`pinned-codex.json` là
config owner + `isolation` (native `passed`, `outer_proof_hash`, `permission_policy_hash`) + capability.
Hai config này qua `HarnessConfigSchema` và `checkConfig` (ready, không blocker); file chỉ chứa
đường dẫn auth, không chứa credential. Test mới `test/unit/spike-002/capability-manifest.test.ts`
kiểm hash manifest tính lại được, config ready, mọi capability có trạng thái, proven có evidence.

| Capability | Claude (Haiku 5.5, 2.1.306) | Codex (Luna, 0.165.0) |
| --- | --- | --- |
| structured_output, schema_acceptance coder/fixer/reviewer | proven | proven (lượt theo candidate) |
| native_inner_sandbox | proven | proven |
| permission_denial_kept | proven (event) | proven (stderr, không có event `--json`) |
| private_home_auth, wall_limit | proven | proven |
| usage_report | proven (token + cost) | proven (chỉ token) |
| cost_limit | unknown | unknown |
| session_resume | unknown (owner không duyệt) | unknown (owner không duyệt) |

Model thực tế: Claude có trong event runtime; effort của Claude, model và effort của Codex chỉ pin
qua argv. `cost_limit` và `session_resume` nằm trong `capability_missing`; theo T070, hard USD cap
không hỗ trợ là `capability_missing`, không thay bằng ước tính, và v1 không resume session.

Quality gates: typecheck/lint/build exit 0; **51 file, 533 test** đạt. Mọi tiêu chí T007 trong phạm vi
owner đã duyệt đều có evidence. **T007 đã đóng** (owner xác nhận 2026-10-28) với `cost_limit` và `session_resume` giữ `unknown`.

## T008 — Live required checks (2026-10-28)

Owner duyệt cho mình tự làm: tạm public repo sandbox, bật/tắt protection và ruleset trên `master`,
đọc bằng port chỉ GET, rồi gỡ hết và đổi về private. Không merge, push, tạo PR hoặc đụng repo khác.
Evidence: [manifest live-rules](../../test/fixtures/runtime/spike-0/github/live-rules/manifest.json),
mọi thao tác ghi nằm trong `admin-ledger.json`.

Đọc qua `readRequiredChecks` + `compareRequired` của port vì `observePull` bỏ qua required checks
với PR đã merged (cả ba PR fixture đều merged). Case `unknown` dùng client ẩn danh (`curl`, không
token), tức người đọc không có quyền Administration; chỉ làm được khi repo public.

| # | Rule bật | Snapshot | Port trả về | Kỳ vọng |
| --- | --- | --- | --- | --- |
| 1 | Classic, `ci/a` any | `ci/a` | required, classic → `covered` | Khớp |
| 2 | Classic, thêm `ci/b` gắn app 15368 | `ci/a,ci/b` | `required_checks_mismatch`, app_pinned `ci/b@app:15368` | Khớp |
| 7 | Như case 2, client ẩn danh | `ci/a` | `unknown`: classic protection HTTP 401 | Khớp |
| 3 | Ruleset active, `ci/c` any | `ci/c` | required, rules/active → `covered` | Khớp |
| 4 | Như case 3 | `ci/x` | mismatch, missing_from_snapshot `ci/c` | Khớp |
| 5 | Ruleset thêm `ci/d` gắn integration 15368 | `ci/c,ci/d` | mismatch, app_pinned `ci/d@app:15368` | Khớp |
| 6 | Ruleset disabled | `ci/c` | `none` → covered rỗng | Khớp |

**Phát hiện và sửa port:** branch chỉ có ruleset vẫn trả `protected: true`, còn endpoint classic
protection trả 404 `Branch not protected`; port cũ coi đó là `unknown` nên case 3–5 sai (lưu ở
`run2-before-fix/`). `readRequiredChecks` nay coi đúng body đó là “không có classic” rồi đọc rules;
404 trơn (không có quyền) vẫn `unknown`. Thêm 2 regression test trong `gh.test.ts`.

Repo public ba lần, mỗi lần khoảng một phút: lượt 1 (đọc qua PR merged nên không có required checks,
`run1-observe-merged-pr/`), lượt 2 (lỗi port), lượt cuối. Đọc cuối: `private: true`, 0 ruleset,
`master` không protected. Không thử được enforcement `evaluate` (cần Enterprise), vẫn chỉ có fixture
local. Quality gates: typecheck/lint/build exit 0; **51 file, 535 test** đạt.

Mọi tiêu chí T008 đã có evidence live: ba merge mode do người dùng merge, push/xóa nhánh sau merge,
head-at-merge proof, classic/rules/none/unknown/app-pinned, immutable repo ID và request ledger.
**T008 đã đóng** (owner xác nhận 2026-10-28). S0.1–S0.3 đều đạt; còn T009 tổng kết.

## T009 — Kết luận gate lát 0 (2026-10-28)

**Kết luận: S0.1, S0.2, S0.3 ĐẠT; gate runtime mở.** Chỉ có giá trị cho host, binary, config và
source hash dưới đây; đổi bất kỳ thứ gì thì manifest mất hiệu lực và phải chạy lại phần liên quan.

### Kiểm khi tổng kết (không gọi model)

| Kiểm | Kết quả |
| --- | --- |
| Hash file trong 5 manifest fixture (host, harness, github ×2, live-rules) | 268 file, 0 lệch, 0 thiếu |
| Schema role (`export-role-schemas.ts --check`) | exit 0, không drift |
| Binary đã pin (node, bwrap, systemctl, systemd-run, flock, Claude 2.1.306, Codex 0.165.0, gh 2.103.3) | khớp sha256/version; kernel `6.18.54.1-microsoft-standard-WSL2` |
| Source prototype so với pin | `sandbox.ts`, `runner.ts`, `role-schema.ts`, probe và test khớp. `harness.ts` đổi sau lượt 1–10: diff chỉ thêm stream summary vào `provenance` sau khi đã validate, argv/plan/sandbox không đổi; lượt 11–12 chạy trên bản mới. `gh.ts` đổi sau merge proof (sửa ruleset-only) |
| Merge proof đọc lại bằng `gh.ts` hiện tại (GET) | 3 PR: identity `match`, merge commit/head candidate/`complete`/`merged_204` khớp evidence cũ; [manifest](../../test/fixtures/runtime/spike-0/github/t009-recheck/manifest.json) |
| typecheck/lint/test/build | exit 0; 51 file, 535 test, 0 skip |

### Từng gate

| Gate | Task | Evidence chính | Giới hạn owner đã chấp nhận |
| --- | --- | --- | --- |
| S0.1 | T006 | `host/manifest.json` (layout, local-boundary, namespace, lifetime, mount-toctou), `harness/…/isolation-record.json` | Chưa kiểm inode trước exec trong prototype; scratch read-only của Codex reviewer chưa có proof runtime |
| S0.2 | T007 | `harness/…/manifest.json` (12/12 lượt), `capability-manifest.json`, `pinned-*.json`, `network*.json`, `stream-summary.json` | `cost_limit`, `session_resume` = unknown; effort (và model Codex) chỉ pin qua argv |
| S0.3 | T008 | `github/real-20261028*/manifest.json`, `github/live-rules/manifest.json`, `github/t009-recheck/manifest.json` | Enforcement `evaluate` chỉ có fixture local |

### Ảnh hưởng thiết kế đã đưa vào tài liệu

- `contracts/execution.md`: kiểm lại (dev, ino) nguồn mount khi exec và fail closed; nguồn bằng chứng
  denial theo vendor (Codex chỉ có stderr). Tasks: T020 (inode), T069 (lưu stderr).
- `contracts/github.md`: ngoại lệ 404 `Branch not protected` với branch chỉ có ruleset.
- Capability: v1 không resume session; hard USD cap là `capability_missing` (T070).

### Rủi ro vận hành

- Toolchain Codex và config owner nằm trong `/tmp` (`/tmp/cusr-spike-002-tools`, `/tmp/cusr-spike-002-owner-*`);
  mất khi `/tmp` bị dọn. Bản config đã lưu trong `pinned-*.json`; T068/T069 phải stage lại binary và
  kiểm đúng sha256 đã pin.
- User manager báo `degraded` vì unit lỗi của lượt Claude đầu tiên được giữ làm bằng chứng.

Thành công lát 0 chỉ chứng minh feasibility; không thay go/no-go sau lát A (T079), SC-001/004/005/008
hay nghiệm thu full workflow ở lát C.
