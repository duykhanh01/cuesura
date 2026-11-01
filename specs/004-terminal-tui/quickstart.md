# Validation guide: feature 004

Hướng dẫn kiểm chứng sau khi triển khai. **Trạng thái 2026-11-01:** chưa có phần nào được triển khai; các lệnh dưới đây là kế hoạch,
không phải bằng chứng. Tiêu chí chưa chạy phải được ghi là chưa đạt trong acceptance report.

## Chuẩn bị

Máy Ubuntu có Node và pnpm theo `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Chạy daemon theo [deploy/README.md](../../deploy/README.md) với một project sandbox, trong một terminal riêng. Mọi lệnh `cusr` dùng cùng
`CUSR_DATA_DIR` và token.

## Kiểm tra tự động

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Kết quả mong đợi: tất cả sạch; các test CLI đã có không phải sửa (SC-006); test PTY trong `test/contract/tui/` chạy với daemon thật và
harness giả lập.

Trước khi merge thay đổi TUI/cấu hình hoặc release, chạy `pnpm test:performance`: SC-002 với 100 task, SC-003 với 20 mẫu cập nhật và kiểm tra idle 30 giây của T033. Test mặc định vẫn kiểm cập nhật màn hình bằng một lần chuyển trạng thái.

Phiên dài và harness thật chạy riêng vì tốn thời gian hoặc usage:

```sh
pnpm test:reliability   # phiên 1 giờ và 8 giờ, cửa sổ kết nối lại, fuzz phím: SC-003, SC-008, SC-009, SC-013
pnpm test:smoke         # hành trình với harness thật: SC-004
```

## Kịch bản bằng tay

### 1. Mở và thoát

1. Chạy `stty -g` và ghi lại kết quả; chạy `cusr`.
   Mong đợi: thấy project, sức khỏe daemon, slot, hàng đợi và task trong 2 giây.
2. Bấm `q`, rồi chạy lại `stty -g`.
   Mong đợi: cùng kết quả, terminal như trước khi mở; task vẫn chạy.
3. Chạy `cusr | cat`, `cusr --json` và `TERM=dumb cusr`.
   Mong đợi: không có ANSI, exit 2 và lỗi `not_available` như hiện tại.

### 2. Mất daemon

1. Mở `cusr`, đang soạn câu trả lời thì dừng daemon.
   Mong đợi: giao diện không thoát; banner dữ liệu cũ hiện kèm `Reconnecting`; không gửi được; nội dung còn nguyên.
2. Khởi động lại daemon trong khoảng 1 phút.
   Mong đợi: có dữ liệu mới trong 10 giây; không tự gửi phần đang soạn.
3. Dừng daemon quá 3 phút rồi khởi động lại.
   Mong đợi: giao diện đứng ở `Retry connection`, không tự kết nối; bấm `R` thì có dữ liệu mới trong 10 giây.

### 3. Tra kết quả sau khi thoát

1. Chạy qua proxy socket `test/support/control-proxy.ts` ở chế độ bỏ phản hồi, để daemon tạo task xong nhưng client không nhận được trả lời.
2. Tạo task qua New task, thấy `result unknown`, bấm `q`.
   Mong đợi: stderr có request ID và lệnh tra cứu.
3. Chạy nguyên văn lệnh đã in, thêm `--json`.
   Mong đợi: `state` là `completed`, có `task_id`, không có task thứ hai; `cusr task board --json` cho cùng số task trước và sau khi tra.
4. Tra bằng token của actor khác.
   Mong đợi: `request_not_found`, exit 4, giống hệt ID không tồn tại.

### 4. Xác nhận

1. Tạo một task có nội dung dài, mở Review ở terminal 80×24.
   Mong đợi: xem hết được mọi trường FR-026 bằng cuộn; danh sách rỗng ghi `None`.
2. Bấm Enter nhiều lần trên Review.
   Mong đợi: không có gì được xác nhận.
3. Dùng CLI đề xuất lại cấu hình khác, rồi gõ `confirm` và gửi.
   Mong đợi: bị từ chối; hiện khác biệt; từ đã gõ bị xóa.

### 5. Hành trình đầy đủ

Làm theo SC-004 với harness giả lập, sau đó với mỗi harness thật ở cả hai chế độ: tạo task, xác nhận cấu hình, trả lời câu hỏi, theo dõi
tới PR xanh, merge thủ công trên GitHub và thấy DONE, không dùng lệnh con nào.

### 6. Người dùng mới

SC-005 cần một người chưa đọc tài liệu; ghi lại thời gian và chỗ bị vướng. Không thay bước này bằng kiểm thử tự động.

## Ánh xạ tiêu chí

| Tiêu chí | Nơi kiểm |
| --- | --- |
| SC-001, SC-002, SC-003, SC-007, SC-010, SC-011, SC-014, SC-015, SC-016 | `test/contract/tui/` |
| SC-006 | Test CLI hiện có, không sửa |
| SC-008, SC-013, cửa sổ kết nối lại của SC-003 | `test/reliability/tui/` |
| SC-009 | Kiểm tra ngắn ở `test/contract/tui/`; phiên 1 giờ ở `test/reliability/tui/` |
| SC-004 | `test/contract/tui/` với harness giả; `test/smoke/` với harness thật |
| SC-005 | Người thật, ghi vào acceptance report |
| SC-012 | Mốc sau, cùng US6 |

Hợp đồng chi tiết: [CLI và daemon](contracts/cli-daemon.md), [giao diện](contracts/tui.md), [data model](data-model.md).
