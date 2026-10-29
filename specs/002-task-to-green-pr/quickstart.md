# Validation guide: feature 002

**Trạng thái 2026-10-29:** nền và phần lớn US1/US2/US4 đã có; cổng Phase 6 đề nghị no-go,
T139 đã kiểm đủ fixture/property/OS; T072/T078 còn mở, chưa có quyết định owner mở B. Xem [go/no-go](go-no-go.md),
[báo cáo nghiệm thu](acceptance-report.md#nghiệm-thu-phase-6--cổng-lát-a),
[ledger seeds](evidence/phase6-seeds.json) và [117 FR](phase6-coverage.md).

Owner chọn Ubuntu; không yêu cầu WSL2. Typecheck/lint/build và default tests đã chạy trên Ubuntu,
bao gồm bwrap và systemd user thật. Node ở trong home làm `harness-bwrap` tự skip: sao cùng binary
ra `/tmp` rồi đưa directory đó lên đầu PATH; không mount host home vào sandbox. Bỏ NO_COLOR/FORCE_COLOR
kế thừa khi chạy suite để không xung đột với test CLI cố ý bật màu. Xem lệnh trong acceptance report.

Hai mode/confirmation/template/checkpoint đã triển khai từng phần theo
[hợp đồng M01–M08/H01–H06](task-execution-modes.md). Same-vendor/session/ro và Q&A/resume/stale packet đã có test local; fixture không chứng nhận paid smoke
hoặc resume/cost capability của vendor thật. T139 đã bổ sung same-vendor/session/ro, Q&A/resume/stale packet, finalized review và ma trận method
freeze/config đổi/replay; xem [matrix T139](acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06).
Feature 002 không gửi merge. Các đoạn hướng dẫn B/C bên dưới là kế hoạch, chỉ chạy sau gate tương ứng;
không được lấy ví dụ lệnh hoặc checkbox task làm bằng chứng runtime đã nối end-to-end.

## 0. Kiểm host và spike ngày 1

Đọc [deploy runbook](../../deploy/README.md) và [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md):
kiểm rootless bwrap/systemd bằng user thường; chỉ admin provisioning nếu policy host cần, không
ép AppArmor 4/child stack hoặc nới sysctl. V1 dùng Isolated, không có backend Native-only/Container.
Sau đó chạy S0.1–S0.3: outer boundary và sandbox nội bộ hai vendor, auth home riêng, 6 role/vendor schemas,
registry/vendor network, systemd lifetime và gh head-at-merge qua ba kiểu merge. Lưu spike report
có exit code/fixture/digest; chưa pass cả ba thì không mở A. Backlog đã có để mở khóa. Không cần daemon hoàn chỉnh
để làm prototype; luôn thử native sandbox bật. Nếu nesting fail, chỉ xét mode external_verified
theo ADR-0004 khi outer proof/permission fixture/owner config đạt; không bypass permission hoặc
dùng production repo để chạy spike.

## 1. Chuẩn bị môi trường

- Node theo `.nvmrc` (24.22.1), pnpm theo package.json; Linux filesystem local, Git, systemd user
  manager và rootless bubblewrap có boundary đạt gate; không bắt buộc AppArmor profile riêng.
  Trên WSL2 cần systemd=true và user-manager
  probe thực tế. Không dùng filesystem Windows cho DB/worktree.
- Dùng data dir riêng trong `/tmp` cho fake/integration; không dùng DB dogfood. Store độc quyền;
  daemon thứ hai phải bị từ chối, CLI/runner không mở DB để ghi.
- User config có project path/repo allowlist, role/model/profile như
  [config 001](../001-deterministic-core/contracts/config.md) và
  [extension 002](contracts/cli-daemon.md). Thực thi setup/gates lấy từ commit base, không từ file dirty.
- Fixture test tạo private home/credential giả và canary secret để kiểm mount/proc/socket/control.
  Doctor không chứng minh được sandbox thì dừng; không bật bypass để cho test thành xanh.

Các lệnh nền hiện có, chạy lại khi triển khai mã/cấu hình:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Commander/entrypoints và `test/contract` đã có trong package/default Vitest project.
Không thêm test mới mà lệnh chuẩn không chạy tới.

## 2. Lát A — Fake tới PR xanh và policy limits

Suite `test/integration/runtime/feature-002-flow.test.ts` đã có fake harness, Git worktree thật/local
bare remote, fake HTTP GitHub và Clock inject. Chạy cùng fixes và contracts; review phụ thuộc mode:

```sh
pnpm exec vitest run --project default test/integration/runtime/feature-002-flow.test.ts
pnpm exec vitest run --project default test/contract
pnpm exec vitest run --project default test/property
```

Expected: task intake/freeze → worktree/code/gates/checkpoint → review nếu full → publish/CI → WAITING/approval merge; đúng
một PR, zero merge request, đầy đủ SHA/binding/usage/evidence. Gây lần lượt gate fail, review changes,
CI code/infra/flaky/auth/refusal/invalid output để kiểm giới hạn và reviewer vendor. Kiểm worktree
ownership, fake process im lặng nhưng có progress, reviewer write denied và canary không lọt log.

Matrix bắt buộc gồm GitHub yêu cầu A/B còn snapshot B/C (mismatch), chỉ yêu cầu B (đạt nếu B/C
success), no-rule none, 403/404 unknown, GitHub app-pinned luôn mismatch với snapshot string[], pending/cancelled/missing/unknown, rerun
pending che success cũ. Base tip đổi chỉ ghi thông tin; head người ngoài đổi thu hồi xanh.

Sau A, dừng ở [go/no-go và mốc ngày 10](plan.md). Chạy 20 seeds của
flow fake, permission/secret assertions, trần/lifecycle/projection và quality gates; ghi effort và
budget B/C để chủ dự án đánh giá. A chưa đạt hoặc no-go thì không mở B.

## 3. Lát B — Recovery, queue và interaction

Suite dự kiến ở `test/integration/runtime/feature-002-recovery.test.ts`,
`test/integration/runtime/feature-002-cli.test.ts` và reliability runtime. Foreground/service-manager
test cần runner unit riêng, không chỉ fake PID. Commands sau chỉ chạy khi suite đã được tạo:

```sh
pnpm exec vitest run --project default test/integration/runtime
pnpm test:reliability --seed 20261028
pnpm report:invariants
```

Runtime crash suite bổ sung ≥200 lần ngắt, không dùng 200 lần của core 001 thay thế. Ledger phân bố
ít nhất 40 lần spawn/nhận runner, 40 output/ACK, 40 commit/push, 40 create/recover PR, 40 merge/drain.
Mỗi nhóm có trước effect, sau side effect thành công, trước ingest xác nhận. Sau mỗi restart:

- Đối chiếu process/receipts/remote trước cấp việc, không trùng attempt/commit/PR; so projection
  dựng lại từ event log với **mọi** bảng lưu, bao gồm queue/slot/cursor/timer, khớp 100%.
- Task A chờ CI nhả slot cho B; khi A cần sửa, đợi theo priority → resumed/fresh → requested_at/
  global_seq. READY ban đầu chưa tiêu deadline, resumed chờ slot vẫn tiêu; restart giữ thứ tự/thời gian.
- Inbox/Q&A/approve có authz/revision/version/dedup. Request 2–5 lần không lặp action. Cancel dừng
  process đúng task và chỉ terminal sau đối chiếu; merged trước cancel → DONE sau drain, không CANCELLED.
- Merge lúc fixer/setup/gate/push còn chạy: chặn effect mới ngay sau ghi fact; nhận late push đúng
  thực tế, giữ local diff/commit. Unknown drain giữ claim, recheck hữu hạn; B chỉ được giải phóng
  sau A DONE và explain hiển thị prerequisite merged_head_unverified.
- Clock tiến qua 30 ngày/2.000 lượt thì observation_expired, không poll nữa; recheck một lượt thấy
  merge vẫn drain→DONE, chưa merge/unknown không bật poll hoặc reset deadline. Drain có hạn riêng.

## 4. Lát C — Smoke xuyên suốt thật

Chỉ chạy khi A/B và permission fixtures đã đạt. Chuẩn bị hai repo GitHub sandbox có CI snapshot
không rỗng và review bắt buộc: một Node, một Python. Có ít nhất một trường hợp no-protection/rules
được API xác nhận, và fixture protected/ruleset/app binding. Cần quyền đọc rules/checks và publish
trên sandbox; model/auth/binding lấy từ tài khoản người vận hành, không dùng tên model giả trong fixture 001.

Schema/auth/nesting đã có fixture từ lát 0; không đợi đầu C mới thử. C dùng project Vitest smoke
opt-in để kiểm toàn luồng thực sự. Binary/auth/mount layout đổi so với manifest lát 0 phải chạy lại
spike bị ảnh hưởng trước khi dùng; help/version không thay evidence. Ghi fixture/version/hash mới.

Các lệnh dự kiến sau khi entrypoints/bin được build và config đã được chuẩn bị:

```sh
export CUSR_DATA_DIR=/tmp/cusr-feature-002-smoke
cusrd --config "$CUSR_CONFIG" --data-dir "$CUSR_DATA_DIR"
```

Chạy daemon ở terminal riêng; terminal CLI dùng cùng `CUSR_DATA_DIR`, token file owner được daemon
tạo trong data dir riêng, hoặc `CUSR_TOKEN_FILE` đã cấp. Các biến `CUSR_CONFIG` và task file bên
dưới là đường dẫn do người vận hành cung cấp, không chứa credential trong nội dung stdout.

```sh
cusr doctor --project node-sandbox --json
cusr status --json
cusr task add --file "$NODE_TASK_FILE" --request-id 019a0000-0000-7000-8000-000000000201 --json
cusr task add --file "$PYTHON_TASK_FILE" --request-id 019a0000-0000-7000-8000-000000000202 --json
cusr task list --json
```

Task file là JSON input theo CLI contract, có project, title, description và acceptance cụ thể.
Một task Claude coder/Codex reviewer, task kia đổi vai; profile CI/gates tương ứng repo. Confirm
nếu task cần xác nhận, dùng ID/version thực từ output. Khi chúng chạy/chờ, thao tác:

```sh
cusr task show "$CUSR_TASK_ID" --json
cusr task explain "$CUSR_TASK_ID" --json
cusr task history "$CUSR_TASK_ID" --json
cusr task logs "$CUSR_TASK_ID" --after 0 --json
```

Với mỗi vendor, ngắt daemon lúc agent còn chạy rồi restart cùng config/data dir, cả foreground và
service-manager fixture. Phải nhận lại cùng attempt, không gọi thêm agent thay thế. Hai task tới
PR xanh không sửa code bằng tay, rồi chủ dự án merge thủ công trên GitHub. Query xác nhận DONE
kèm đúng merged head/checked head/merge commit và zero system merge request.

Smoke riêng trên sandbox kiểm merge/squash/rebase và push source branch sau merge, tái dùng/đối chiếu fixture gh-port đã có từ lát 0 để kiểm adapter không
nhận nhầm HEAD mới. Không suy ra hỗ trợ từ chỉ một kiểu merge.
Sau observation_expired hoặc drain paused, thử recheck bằng ID/version/request mới:

```sh
cusr task recheck "$CUSR_TASK_ID" --expected-version "$CUSR_TASK_VERSION" --request-id 019a0000-0000-7000-8000-000000000203 --json
```

Recheck không gọi agent/merge/reset hạn. Với needs_info config_invalid/capability_missing, sửa base
hoặc môi trường rồi confirm/recheck request mới: chỉ kiểm/chốt khi đủ điều kiện, không tự poll base.
Merge unverified và các failure permutations có fake/contract trước, smoke ghi rõ case thật nào chạy.

## Kiểm quyền assistant

Owner cấp token riêng `[read,operate]` có project allowlist theo CLI contract, không chia sẻ token
bootstrap admin. Dùng assistant token để add/show/cancel/recheck, rồi thử approve escalation hoặc
tự khai role admin: phải exit 5 và không mutation quyền. Thử task khác project cũng bị từ chối.
Client/connector assistant không có quyền đọc token owner; worker agents không thấy cả token operate.
Owner xóa grant, restart daemon, token cũ bị từ chối cho mutation mới; đã accepted vẫn giữ audit.

## 5. Báo cáo nghiệm thu

Ghi `acceptance-report.md` khi validation thật được chạy: commit/config hashes, OS/filesystem,
Node/pnpm/Git/systemd/bwrap/harness versions, exit codes, seed/crash distribution, request-vs-effect
counts, projection report, redacted fixture paths, PR URLs/SHA/receipts và mọi mục chưa kiểm.

Mỗi dòng [acceptance map](contracts/acceptance-map.md) phải có evidence cụ thể; một test có thể phủ
nhiều dòng nếu từng assertion kiểm độc lập. Có đủ I01–I12/S01–S10/R1–R9; không báo full I11 an toàn
merge ngoài hệ thống, hoặc full R7/R9 khi chưa chạy. Thiếu repo/auth/model quyền thật thì giữ lát C
chưa kiểm; không dùng fake để thay SC-001/002/005/008.
