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
3. Trong outer sandbox đó, chạy **harness với sandbox nội bộ còn bật**, cho cả Claude và Codex:
   một lần read-only, một lần workspace-write theo role. Kiểm đọc/ghi thực qua tool, không chỉ
   process start. Cấm coi `--dangerously-*` hoặc tắt sandbox nội bộ là biện pháp để pass.
4. Nếu nested userns/landlock fail, ghi error/argv/mounts/kernel audit đã redact, **dừng trước A**.
   Chỉ thay backend sau review ADR/plan mới; không chuyển việc này thành test để làm sau implement.
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
- Các lượt này đồng thời kiểm sandbox nội bộ còn bật, auth home riêng, output parse/semantic/schema,
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
| S0.1 | Profile đã provisioning; host/nested permission probes, lifetime/cgroup fixtures | Fail host / phần còn lại chưa chạy |
| S0.2 | 6 role/vendor outputs, auth home, quyền/network, version/schema digests và usage | Chưa chạy |
| S0.3 | 3 merge modes, source push/delete, head proof và gh-port evidence | Chưa chạy |

Kết quả ghi vào `spike-0-report.md` khi chạy thật, gồm lệnh/exit code, fixtures và hạn chế từng mục.
Chưa tạo báo cáo pass hoặc capability manifest proven khi chưa có kết quả. Gate đạt khi cả ba mục
đạt; nếu fail, làm rõ phương án mới với chủ dự án thay vì nới quyền/giới hạn để tiếp tục A.

Go/no-go kế tiếp là sau lát A, chậm nhất mốc ngày 10 được ghi trong plan. Thành công lát 0 chỉ
chứng minh feasibility, không thay SC-001/004/005/008 hoặc nghiệm thu full workflow thật ở lát C.
