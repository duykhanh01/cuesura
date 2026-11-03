# Thời gian và phạm vi bộ test

`pnpm test` chạy unit, scenario, property, integration và contract trong một job CI. Performance,
reliability và smoke là các project riêng, đã không thuộc CI mặc định. Không dùng shard hay self-hosted. Chưa thêm cache pnpm vì install chỉ chiếm khoảng 10–15 giây;
chi phí khôi phục/lưu cache và bootstrap pnpm có thể làm lợi ích ròng không đáng kể.

## Baseline

Log [run 41563138077](https://github.com/duykhanh01/cuesura/actions/runs/41563138077): test 576,83 giây,
build job 54 giây, cài dependency test 11 giây. Đây là số đo tham chiếu của một PR trước; thời gian
thay đổi theo revision và tải runner, không phải benchmark cùng commit.

| File | Giây | Vì sao giữ |
| --- | ---: | --- |
| `test/contract/tui/us1-live.test.ts` | 76,4 | Reconnect, thu hồi quyền, đổi token, khôi phục terminal trên PTY thật |
| `test/integration/runtime/harness-proof.test.ts` | 72,8 | Chứng minh sandbox, resume và ghi evidence qua process/systemd thật |
| `test/contract/tui/us2-logs.test.ts` | 47,9 | Cursor, pause/follow, cuộn và giới hạn log trên terminal thật |
| `test/integration/runtime/feature-002-flow.test.ts` | 41,3 | Git worktree, commit, gate, review, publish và recovery cùng chạy |
| `test/integration/runtime/base-update-flow.test.ts` | 36,0 | Cập nhật base, conflict repair và tái chứng nhận bằng Git thật |
| `test/contract/tui/us2-explain-refresh.test.ts` | 34,2 | Watermark, version và refresh khi thời gian daemon đổi mà task không đổi |
| `test/contract/tui/us1-home.test.ts` | 19,8 | Hiển thị trạng thái, lọc và điều hướng trên terminal |
| `test/integration/runtime/feature-002-cli.test.ts` | 19,1 | Lệnh CLI đi qua admission, store và daemon |
| `test/contract/tui/us2-detail.test.ts` | 18,3 | Provenance, cách thoát wait và giới hạn tài nguyên |
| `test/integration/runtime/cancel-drain.test.ts` | 16,1 | Hủy/drain không bỏ process, reservation hay evidence |

Sáu file đầu chiếm khoảng 309/544 giây tổng thời gian các file được log. Chúng kiểm tra ranh giới
thật khác với unit test; không thể xóa cả file chỉ vì chậm. Các property test kiểm invariant trên nhiều
đầu vào; không giảm số mẫu hoặc bỏ kiểm determinism/replay để làm CI nhanh hơn.

## Thay đổi có thể giữ coverage

- Giữ một test PTY đại diện cho daemon không tương thích. Các biến thể dữ liệu sai, envelope sai và query
  không tồn tại được giữ ở mức socket thật trong `test/integration/runtime/client-deadline.test.ts`
  và được kiểm riêng ở `test/unit/tui/daemon-port.test.ts`; trạng thái dừng/retry được kiểm ở
  `test/unit/tui/refresh.test.ts`. Không cần lặp trọn luồng PTY và các khoảng chờ âm tính cho từng biến thể.
- Khi đợi một phản hồi tích cực, kết thúc ngay khi thấy điều kiện cần thay vì ngủ đủ một cửa sổ cố định.
  Các cửa sổ đo không có request, timeout, reconnect và giới hạn refresh thật vẫn phải giữ đủ thời gian
  để phát hiện hành vi sai; không rút ngắn tùy ý.

Không bỏ coverage Git thật, crash/restart, bảo mật, quyền truy cập hay phục hồi chỉ vì đã có fake/unit
cho một phần của luồng. Không đổi fixture file store thành memory cho các bài cần chứng minh durability.

## Test chức năng đã bỏ

Bỏ bốn bài khẳng định `external_verified` có thể được bật/chạy thành công: hai bài adapter contract
(`harness`, `sandbox-permissions`), một bài `harness-invocation` và một bài preflight. Chúng chạy qua
fake provider/manifest của outer sandbox cũ, không phải đường host hiện tại. `hostSandbox()` hiện dùng
provider host; loader từ chối manifest outer cũ và cả hai adapter từ chối `external_verified` khi chạy
trên host. Giữ các test từ chối cơ chế cũ ở `test/unit/runner/host-execution.test.ts` và các test
manifest/evidence không hợp lệ. Không xóa fixture stream vendor còn được dùng để kiểm parser.

Đây là dọn coverage lỗi thời, không phải nguồn tiết kiệm thời gian lớn. Sau khi bỏ bốn case cũ,
tập test dự kiến còn 2.559 case; các luồng sandbox native, credential và reviewer write guard vẫn giữ.

## Thử nghiệm không giữ lại

Đã thử `NODE_COMPILE_CACHE` cho các process con. Khởi động CLI riêng lẻ nhanh hơn khi cache đã ấm,
nhưng [run toàn suite](https://github.com/duykhanh01/cuesura/actions/runs/41576260093) mất 10 phút 37 giây
ở bước test, so với 9 phút 41 giây của
[baseline cùng source test trước tối ưu](https://github.com/duykhanh01/cuesura/actions/runs/41571111149).
Các file không sửa cũng chậm hơn, nên chưa thể quy toàn bộ chênh lệch cho cache. Không giữ cấu hình cache
khi chưa chứng minh được lợi ích trên toàn suite. Workflow cuối cùng giữ một job `pnpm test`, không thêm cache dependency hay cache biên dịch Node.

Ở run có cache, hai file sửa giảm từ 76,856 + 34,339 xuống 61,273 + 26,982 giây. Số đo host một worker
cũng giảm từ 82,31 + 38,45 xuống 67,31 + 32,05 giây. Đây là bằng chứng cho phạm vi hai file, không phải
cam kết giảm tương ứng tổng CI trên mọi runner. Ba biến thể PTY được chuyển xuống socket thật, tổng số
case vẫn là 2.563 trước khi dọn các test chức năng đã bỏ.

## Đọc số đo tiếp theo

Vitest ghi thời gian từng assertion trong `reports/vitest-default.json`. So sánh cùng tập file, cùng
số worker, rồi xác nhận bằng toàn bộ CI; không lấy thời gian chỉ chạy lại file lỗi làm thời gian cả bộ.
Ghi cả số test skip và lỗi môi trường. Host hiện dùng Git 2.34.1 thiếu `merge-tree --write-tree`, nên
cần Git mới khi xác nhận các bài cập nhật base.
