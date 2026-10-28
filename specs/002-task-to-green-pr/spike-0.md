# Lát 0 — Kiểm chứng giả định trước khi xây runtime

**Trạng thái: BLOCKED / chưa đạt.** Theo [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md),
luồng tự động v1 dùng Isolated rootless bwrap, không bắt buộc AppArmor 4/child stack Cuesura.
[Canary local 360/360](sandbox-reassessment.md) là bằng chứng một phần; chưa đủ outer proof đầy đủ,
native nội bộ/permission/auth thật và GitHub proof. Xem [báo cáo hiện trạng](spike-0-report.md).
Backlog đã tạo để mở khóa, nhưng A vẫn đợi S0.1–S0.3; không đánh dấu pass bằng docs/help/fake.

“Native sandbox” trong guide này là sandbox **nội bộ** của harness chạy trong Isolated. Không
có backend Native-only, Container/VM hay plugin registry trong v1. Profile AppArmor cũ là
hardening tùy chọn; không dùng việc thiếu profile đó để chặn một host đã chứng minh đủ boundary.

## S0.1 — Host, nested sandbox và process lifetime

1. T002 kiểm prerequisite theo [deploy runbook](../../deploy/README.md), không sửa policy host.
   Lưu OS/kernel/Node/bwrap version/hash, AppArmor label/policy/sysctl nếu có (không có thì ghi rõ),
   exit probe userns bằng user thường và probe create/query/stop user unit. Chỉ admin provisioning
   nếu policy host cần; không ép AppArmor 4 hoặc sysctl=1 trên mọi host. Giữ nguồn kết quả host cũ
   và worker riêng. Sửa scope/comment/report prototype còn nhắc child stack bắt buộc theo ADR-0004.
2. Dùng sandbox prototype tối thiểu đúng mount/PID/home/network layout của
   [execution contract](contracts/execution.md), chưa cần daemon/store hoàn chỉnh. Canary ngoài
   mount, socket admin, home host và git metadata phải không truy cập/ghi được; reviewer không ghi
   repo; coder/fixer chỉ ghi vùng được cấp, gồm worktree/scratch/private-home/tmp theo layout.
   Dùng socket Unix và FD canary thật để kiểm không thừa kế quyền qua descriptor, systemd bus
   hoặc socket điều phối; không chỉ kiểm tên path không tồn tại. Kiểm mọi vùng rw và path/symlink
   race không mở lại host/admin secret hay sửa vùng ro. Kiểm process con không thoát ownership/cgroup.
   Chạy lại canary sau re-exec `/usr/bin/bwrap`, bản copy trong scratch, raw userns và thử
   remount/unmount Git metadata/vùng ro. Ghi label/CapEff/errno thực; namespace con có thể tạo được,
   không tự là fail nếu không vượt boundary. Tái sử dụng [reassessment](sandbox-reassessment.md)
   và `scripts/spike-002/reassess-sandbox.ts`; 360 checks là đầu vào, không thay các case còn thiếu.
   Giữ no-new-privileges/cap drop. Nếu host chọn hardening AppArmor, thêm fixture/audit riêng;
   [probe child stack](../../deploy/apparmor/probe-child.py) không là gate phổ quát.
3. Trong outer sandbox đó, **vẫn thử harness với sandbox nội bộ bật** trên từng vendor/version,
   read-only và workspace-write theo role. Đo đọc/ghi thực qua tool, không chỉ startup. Ghi native
   result/argv/settings/audit thật; nesting fail vẫn ghi failed, không đổi nó thành pass khi dùng mode khác.
   Xác nhận tool thực sự chạy trong lớp nội bộ, không chỉ config enabled: với Claude, pin các
   settings được version hỗ trợ để fail khi sandbox unavailable và cấm unsandboxed retry; không
   để fallback mặc định âm thầm biến native probe thành chạy chỉ với outer rồi báo native pass.
4. Nếu native fail vì nesting, chỉ thử `external_verified` theo ADR-0004
   sau khi outer layout ở bước 2 đã chứng minh boundary và owner cho phép trong trusted config.
   Chỉ tắt lớp OS sandbox qua settings/sandbox mode; giữ nguyên permission/deny/approval policy,
   không `--dangerously-*`, bỏ rule/permission hoặc thêm CAP_SYS_ADMIN override. Managed policy
   bắt buộc native thì không override. Native pass ưu tiên giữ native, không mặc định downgrade.
   Negative fixtures ở mode được chọn phải kiểm tool bị deny trên **đường dẫn/command mà outer
   sandbox cho phép**: canary trong scratch rw hoặc lệnh vô hại bị rule deny không được thực thi.
   Ghi quyết định permission trước side effect; lỗi EROFS/auth/network từ outer không thay bằng
   chứng tool rule giữ nguyên. So effective permission/approval settings và hash với baseline.
   Nếu outer proof hoặc permission fixtures chưa đạt/mode không tách được hai lớp, gate vẫn đóng
   để review cách ly khác. Không tự fallback theo từng tool call, không đổi mode do agent yêu cầu.
5. Prototype runner qua `spawn(systemd-run --user ...)`: daemon foreground chết và daemon unit
   stop/restart đều không dừng runner unit riêng. Dừng runner unit phải dừng toàn descendants.
   Doctor kiểm user manager truy cập được; WSL phải bật systemd và restart distro theo runbook.

## S0.2 — Home/auth/network và schema: ba role × hai vendor

- Pin binary/version/digest, model ID, flag/settings và auth mode từ môi trường được cấp. Home
  harness mới chỉ có selected auth và settings cần thiết, không copy toàn home/CLI config chủ dự án.
  Auth sandbox/namespace và session resume phải dùng đúng cấu hình định triển khai.
- Export coder/fixer/reviewer JSON Schema từ Zod hiện có của prototype theo SPEC §12.3; closed
  root object/required/null. Chạy **6 invocation trả phí**: coder, fixer, reviewer trên mỗi vendor.
  Giới hạn 5 phút/invocation, một bước sửa rất nhỏ trong fixture; không chạy luồng task-to-PR.
  Nếu cần thêm lượt để sửa cờ/config, dừng và báo kết quả trước khi vượt 6 lượt, không retry không trần.
- Các lượt này kiểm mode thực tế đã chọn/proven ở S0.1 (native hoặc external_verified có điều kiện),
  quyền tool không bị bypass, auth home riêng, output parse/semantic/schema,
  model/effort/quyền thực tế, usage reported/unavailable, giới hạn wall/cost được yêu cầu và phản hồi
  khi tool bị từ chối. Không suy rằng một role chấp nhận schema chứng minh hai role còn lại.
- Setup/gate prototype thử tải package nhỏ bằng pnpm và pip trong isolated scratch; agent gọi vendor
  qua mạng mặc định internet_outbound. Không cấp GitHub/admin/SSH/model secret cho setup/gate.
  Không tuyên bố chặn LAN/loopback khi đang share host network.
- Fixtures failure/refusal/rate-limit/truncation ghi nguồn/version rõ: capture thật nếu đã gặp và
  synthetic riêng cho parser negative cases. Không cố tiêu quota để gây rate-limit, không báo
  synthetic fixture là auth/cost/rate-limit thực đã kiểm. Khả năng chưa có bằng chứng giữ unknown.

Giới hạn 6 lượt ở đây là kế hoạch thử nghiệm, **không** xác nhận đã tiêu usage hoặc có credential.
Khi chạy phải có tài khoản/model và sự cho phép dùng usage cho spike; không dùng token từ log.
Các lần thử native/fallback có gọi model đều tính chung trần 6 lượt, kể cả startup/tool failure;
không tự tăng budget để đủ sáu output thành công, hết lượt phải báo và xin quyết định trước thử thêm.

## S0.3 — GitHub head-at-merge qua port gh

Chỉ trên repo sandbox được cấp cho spike, không dùng repo sản phẩm `metronome`. Dùng `gh` port
prototype với timeout/cap giống contract, lưu raw response đã redact/digest và immutable repo ID.
Tạo ba PR nhỏ cho merge commit/squash/rebase; ghi head đã biết trước merge và merge commit sau đó.
Người dùng thực hiện merge thủ công; Cuesura/prototype không gửi merge request.

Sau merge, push thêm vào source branch còn tồn tại rồi đọc PR lại; kiểm `.head.sha`/nguồn proof có
còn biểu diễn head tại merge hay không. Có case source branch bị xóa. Chỉ pass khi nguồn merge
proof xác định được đúng head-at-merge cho từng mode; nếu API hiện tại không đủ, giữ S0.3 fail và
sửa thiết kế proof trước A. Không đợi hoàn thành cả runtime rồi mới phát hiện thiếu nguồn bằng chứng.

Trong cùng sandbox đọc classic/rules/no-rule/unknown và app-pinned requirement: snapshot vẫn là
`string[]`; any-app + cùng tên được xét subset, app cụ thể trả required_checks_mismatch. Không cần
thay FrozenPolicy/event schema để chạy probe. Ghi gh version/API version/request ledger.

## Prototype và lệnh chạy (T003–T005)

Prototype nằm ở `scripts/spike-002/`, chạy trực tiếp bằng `node`, không import runtime A,
daemon, store hay entrypoint. **Mặc định mọi lệnh dưới đây chỉ chạy local**: không gọi model,
không gọi GitHub, không sudo, không nạp profile hay đổi sysctl. Prototype chạy được không có
nghĩa S0.1–S0.3 đã đạt, và nó không thay cho bằng chứng mà T006–T009 phải thu.

| Phần | Lệnh | Phạm vi |
| --- | --- | --- |
| Schema (T003) | `node scripts/spike-002/export-role-schemas.ts [--check]` | Xuất JSON Schema/digest từ Zod vào `test/fixtures/runtime/spike-0/schema/`; `--check` exit 1 khi lệch |
| Sandbox (T004) | `node scripts/spike-002/sandbox.ts argv --layout FILE` | In argv bwrap và bảng mount theo role, không exec |
| | `node scripts/spike-002/sandbox.ts probe --all` | Repo/worktree tạm và canary mount/PID/env/secret/control cho 5 role; ghi nhãn AppArmor nhưng không đánh giá. `--apparmor-fixture` chỉ dành cho hardening tùy chọn đã được admin review |
| | `node scripts/spike-002/reassess-sandbox.ts` | Fixture tạm cho baseline/nested/copied bwrap/raw-userns; kiểm truy cập sau remount/unmount. Không gọi model/GitHub, không thay full S0.1 |
| Runner (T004) | `node scripts/spike-002/runner.ts systemd-argv --spec FILE --root DIR` | In argv `systemd-run --user` + `flock` của unit `cusr-op-<op>.service`, không chạy |
| | `node scripts/spike-002/runner.ts start --spec FILE --root DIR [--systemd]` | Chạy runner dưới flock (local hoặc trong unit riêng) |
| | `node scripts/spike-002/runner.ts receipt --root DIR --kind runs\|operations --id ID` | Đọc launch/pid/exit và identity: `not_launched/unknown/running/lost/finished` |
| | `node scripts/spike-002/runner.ts status\|stop --operation-id ID` | `systemctl --user show/stop` đúng unit của operation |
| Harness (T004) | `node scripts/spike-002/harness.ts check --config FILE` | Kiểm config tường minh; template trong `scripts/spike-002/config/` cố ý chưa ready |
| | `node scripts/spike-002/harness.ts plan --config FILE --role R --root DIR --attempt-id ID --worktree DIR --git-dir DIR [--toolchain DIR]...` | In argv harness + bwrap, run spec và manifest (capability `unknown`); không copy auth, không spawn |
| | `node scripts/spike-002/harness.ts run <plan args> --prompt FILE --ledger FILE [--allow-paid]` | Claude/Codex bắt buộc `--allow-paid` và giữ chỗ trong ledger **trước** spawn; vendor `fixture` không tốn budget |
| | `node scripts/spike-002/harness.ts ledger --ledger FILE` | Xem số lượt đã giữ chỗ trên trần 6 |
| gh port (T005) | `node scripts/spike-002/gh.ts observe --repo O/R --pr N --snapshot a,b --fixture FILE` | Chạy bundle đọc trên fixture local `test/fixtures/runtime/spike-0/gh-port/` |
| | `node scripts/spike-002/gh.ts observe ... --live [--gh PATH] [--evidence-out FILE]` | Chỉ dùng ở T008 trên repo sandbox đã được cấp; chỉ GET, không có endpoint merge/create/rerun |

Kiểm thử local nằm trong `pnpm test` (`test/unit/spike-002`, `test/integration/spike-002`). Test
bwrap tự skip khi host chặn user namespace, test systemd tự skip khi không có user manager. Test
bị skip được tính là **chưa chạy**, không phải đạt.

Giới hạn của prototype, cần T006–T008 xác nhận hoặc sửa:

- T004 giữ thông điệp scope của ADR-0003 trong `sandbox.ts`; T002 phải cập nhật chúng theo
  ADR-0004. Không coi dòng nhắc thiếu child stack trong output cũ là blocker mới, cũng không
  coi việc sửa thông điệp là full outer proof. Không sửa lại file evidence lịch sử.
- Runner chạy local ngoài unit chỉ sở hữu process group: process con thoát bằng `setsid` vẫn sống
  (exit.json ghi `descendant_scope=process_group_only`). Trong unit `cusr-op-*` thì runner quét
  cgroup và systemd dừng toàn bộ cgroup. Main process của unit là `flock` bọc bởi `sh` có
  `trap "" TERM`, để runner kịp dừng nhóm harness và ghi exit.json khi unit bị stop.
- Ledger chỉ giữ chỗ giữa các lần gọi; prototype không tự retry và không tự đổi mode. Template
  harness lấy tên flag từ `--help` (Claude Code 2.1.306, codex-cli 0.164.0 trên máy worker), chưa
  phải bằng chứng. Ví dụ, pointer `structured_output` của Claude chưa được kiểm chứng.
- Exchange schema chỉ dùng tập keyword thận trọng (`type/properties/required/additionalProperties/
  items/enum/const/anyOf`). Độ dài, giới hạn và luật status/verdict được kiểm sau parse.
  Harness có chấp nhận schema này hay không thì do S0.2 xác định riêng cho từng role × vendor.
- gh port ghi head-at-merge là ứng viên `pulls.head.sha` với `proof_status=unverified_pending_s0_3`.
  Ruleset có enforcement không đọc được thì cả bộ required checks là `unknown`.

Khi chạy T006–T008, lưu output prototype (probe report, run dir đã redact, manifest, ledger,
evidence gh) vào thư mục fixture tương ứng kèm command/exit code. Budget 6 lượt × 5 phút và
gate dưới đây giữ nguyên.

## Gate trước runtime A

| Mục | Bằng chứng bắt buộc | Trạng thái hiện tại |
| --- | --- | --- |
| S0.1 | Isolated outer layout/canary/FD/socket/re-exec/copy/raw-userns/lifetime đạt; mỗi vendor có native nội bộ result và native pass hoặc external_verified pass với permission evidence/owner config | Local canary một phần đã đạt; thiếu proof đầy đủ trên host triển khai và mode vendor proven |
| S0.2 | 6 role/vendor outputs, auth home, quyền/network, version/schema digests và usage | Chưa chạy |
| S0.3 | 3 merge modes, source push/delete, head proof và gh-port evidence | Chưa chạy |

Điều kiện pass S0.1 cho **mỗi** vendor: outer boundary + lifetime đạt, và một trong hai nhánh:
native đạt, hoặc native đã thử/ghi thất bại + owner cho phép external_verified + mode đó giữ
permission/approval qua negative fixtures và chạy được role/schema/auth. Report giữ hai kết quả
native/fallback riêng; exception chỉ hợp lệ cho đúng hashes/version/layout đã kiểm, đổi thì kiểm lại.

Kết quả ghi vào `spike-0-report.md` khi chạy thật, gồm lệnh/exit code, fixtures và hạn chế từng mục.
Chưa tạo báo cáo pass hoặc capability manifest proven khi chưa có kết quả. Gate đạt khi cả ba mục
đạt; nếu fail, làm rõ phương án mới với chủ dự án thay vì nới quyền/giới hạn để tiếp tục A.

Go/no-go kế tiếp là sau lát A, chậm nhất mốc ngày 10 được ghi trong plan. Thành công lát 0 chỉ
chứng minh feasibility, không thay SC-001/004/005/008 hoặc nghiệm thu full workflow thật ở lát C.
