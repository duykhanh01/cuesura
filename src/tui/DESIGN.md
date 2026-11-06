# Giao diện TUI

Quy định chung cho mọi màn của `cusr`. Sửa view thì giữ đúng các điểm dưới đây; muốn đổi thì đổi ở đây trước.

## Màu theo vai trò

View gọi tên vai trò trong `views/theme.ts`, không tự viết màu. `test/unit/tui/theme.test.ts` chặn việc này.

| Vai trò | Nghĩa | Dùng cho |
| --- | --- | --- |
| `GOOD`, `GOOD_STRONG` | Đã chạy, đạt | Stage xong, gate pass, daemon khỏe |
| `BAD`, `BAD_STRONG` | Lỗi, bị từ chối | Stage fail, tool lỗi |
| `NOTICE`, `WARN` | Tạm dừng hoặc cần đọc, chưa hỏng | Đang chờ, việc cần người dùng, dữ liệu cũ |
| `STOPPED`, `STOPPED_STRONG` | Đã hủy | Task bị hủy; màu cam vì vàng đã là chờ |
| `ACTIVE` | Đang chạy, con trỏ | Stage hiện tại, `◂ reading` |
| `FOCUS` | Chỗ mắt cần dừng | Dòng đang chọn, phím, heading chính |
| `DIM`, `BOLD` (`views/ink.ts`) | Cấp chữ | Phụ, nhấn |
| `FAINT` | Vắng mặt | Stage bị bỏ theo mode |

## Mỗi trạng thái hai tín hiệu

Đúng một tín hiệu màu cộng một tín hiệu không màu (ký hiệu hoặc chữ). Không thêm tín hiệu thứ ba. Với `NO_COLOR`,
ký hiệu một mình vẫn phải phân biệt được.

| Trạng thái | Ký hiệu |
| --- | --- |
| Xong | `✓` |
| Đang chạy | `●` (hàng Home `◉`) |
| Đang chờ | `‖` |
| Lỗi | `✕` |
| Đã hủy | `■` |
| Chưa tới | `○` |
| Bỏ theo mode | `–` |
| Không chạy nữa | `·` |

## Cỡ màn

- Sàn là 80×24. Dưới sàn chỉ hiện thông báo cần mở rộng cửa sổ.
- Rail một dòng dùng `stepperRow`: bỏ stage đã qua ở đầu trước, rồi stage chưa tới ở cuối, chỗ bỏ ghi `…`. Stage hiện
  tại, đang chờ hoặc nơi task kết thúc luôn nguyên vẹn.
- Cắt bằng số ô (`displayWidth`, `truncate`), không bằng độ dài chuỗi. Tiếng Việt và ký tự rộng phải có frame test.
- Bảng cắt, không wrap; giá trị đầy đủ nằm ở footer hoặc màn chi tiết.

## Khung và mật độ

- Tối đa một lớp viền từ mép terminal tới nội dung. Vùng log dài không có viền dọc, để copy không dính viền.
- Cùng một thông tin không lặp ở nhiều nơi trên một màn. Một project thì ẩn cột Project và dòng `Projects:`, từ hai
  project thì hiện lại.
- Khoảng cách theo hàng trống và cột cố định, không theo khung.

## Trạng thái của một mục

Mục chờ dữ liệu phải nói đúng một điều:

| Trạng thái | Hiện |
| --- | --- |
| Đang đọc | `Reading…` |
| Đọc lỗi | Lỗi nói rõ, mục phụ thuộc hiện `Could not be read.` |
| Không có gì | Một câu trả lời cụ thể, như `No steps yet`; đó không phải là đang chờ |
| Dữ liệu cũ | Giữ dữ liệu, kèm cảnh báo `WARN` |

## Log

Record không đọc được bằng lời chỉ chiếm một dòng ghi loại của nó. JSON đầy đủ nằm sau `Ctrl-O`, không bao giờ hiện
ở chế độ mặc định.
