# Lát 0 — Kiểm chứng giả định trước khi xây runtime

**Trạng thái: BLOCKED / chưa đạt.** Xem [kết quả đã chạy](spike-0-report.md). Host userns probe đã fail ngày 2026-10-28; profile AppArmor chưa
được cài và các thử nghiệm model/GitHub dưới đây chưa chạy. Đây là điều kiện mở lát A, không để
sau A/B và không được đánh dấu pass bằng docs/help. `/speckit-tasks` bị chặn cho tới khi gate này
có bằng chứng hoặc chủ dự án review thiết kế thay thế; không sinh tasks triển khai trên giả định cũ.

## S0.1 — Host, nested sandbox và process lifetime

1. Quản trị viên provisioning theo [deploy runbook](../../deploy/README.md), giữ restriction userns=1.
   Lưu OS/kernel/AppArmor/bwrap version, profile path/hash, sysctl trước/sau và exit code probe user
   thường. Không ghi câu “lỗi riêng phiên agent”; baseline host đã được xác nhận fail.
2. Dùng sandbox prototype tối thiểu đúng mount/PID/home/network layout của
   [execution contract](contracts/execution.md), chưa cần daemon/store hoàn chỉnh. Canary ngoài
   mount, socket admin, home host và git metadata phải không truy cập/ghi được; reviewer không ghi
   repo; coder/fixer chỉ ghi worktree/scratch. Kiểm process con không thoát ownership/cgroup.
   Profile theo [ADR-0003](../../docs/adr/0003-bwrap-child-capabilities.md): descendants luôn có
   child stack enforce và capability denial. Chạy [fixture](../../deploy/apparmor/probe-child.py)
   cho process con, re-exec `/usr/bin/bwrap` và bản copy trong scratch; đối chiếu audit capability
   với thời điểm/nhãn probe, kiểm thao tác mount namespace cần CAP_SYS_ADMIN bị EPERM. Userns có
   thể vẫn được tạo vì mẫu upstream allow userns; không lấy CapEff=0 hoặc chỉ một exit lỗi làm
   bằng chứng. Fixture chạy ngoài đúng stack phải fail trước probe, không ghi nhầm thành pass.
3. Trong outer sandbox đó, **vẫn thử harness với sandbox nội bộ bật** trên từng vendor/version,
   read-only và workspace-write theo role. Đo đọc/ghi thực qua tool, không chỉ startup. Ghi native
   result/argv/settings/audit thật; nesting fail vẫn ghi failed, không đổi nó thành pass khi dùng mode khác.
   Xác nhận tool thực sự chạy trong lớp nội bộ, không chỉ config enabled: với Claude, pin các
   settings được version hỗ trợ để fail khi sandbox unavailable và cấm unsandboxed retry; không
   để fallback mặc định âm thầm biến native probe thành chạy chỉ với outer rồi báo native pass.
4. Nếu native fail vì nesting, chỉ thử `external_verified` theo [ADR-0003](../../docs/adr/0003-bwrap-child-capabilities.md)
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

## Gate trước tasks/A

| Mục | Bằng chứng bắt buộc | Trạng thái hiện tại |
| --- | --- | --- |
| S0.1 | Outer layout/canary/capability/lifetime đạt; mỗi vendor có native result thật và native pass hoặc external_verified pass với permission evidence/owner config | Fail host / chưa có outer proof hoặc mode proven |
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
