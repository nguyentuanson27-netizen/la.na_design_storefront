# Spec — Đánh giá khách hàng nhập tay (REVIEWS-001)

**Trạng thái:** v1 triển khai trên nhánh, chờ owner duyệt migration `20261108100000_add_product_review` (bảng mới, chỉ thêm, không đổi bảng cũ).
**Bối cảnh:** trang sản phẩm chưa có đánh giá hay bình luận. Ảnh feedback hiện là kho ảnh chung của shop (chỉ gắn riêng cho sản phẩm khi có biến thể `ANH-FEEDBACK-<mã>`), nên không nói được "khách đã diện mẫu này".

## Nguyên tắc: chỉ đánh giá có thật

Đánh giá do **shop nhập tay vào trang quản trị từ phản hồi thật** của khách (Zalo, Messenger, bình luận Facebook, gửi trực tiếp) và **khách đã đồng ý cho đăng**. Hệ thống không sinh, không ước lượng và không cho gõ tay điểm tổng.

- **Đồng ý đăng:** không lưu được nếu chưa tick xác nhận khách đồng ý (`consentConfirmedAt` NOT NULL ở DB).
- **Nguồn hiển thị công khai:** mỗi đánh giá in nguồn ("Gửi qua Zalo"…), để người đọc phân biệt với đánh giá để lại trên website.
- **"Đã mua hàng"** chỉ hiện khi đánh giá gắn một mã đơn mà hệ thống kiểm tra được: đơn tồn tại, `CONFIRMED`, và có dòng thuộc sản phẩm này (theo slug PDP đã đóng băng trên dòng đơn, hoặc theo sản phẩm của biến thể). Không gắn được thì không có nhãn.
- **Ngày** là ngày của đánh giá gốc, không phải ngày nhập, và không được sau hôm nay theo lịch Việt Nam (so ngày lịch, không so thời điểm).
- **Tên hiển thị** chỉ nhận đúng dạng: tên gọi, hoặc một đến hai từ kèm chữ cái đầu của họ ("Lan", "Lan A.", "Thu Hà T."). Hệ thống từ chối họ tên đầy đủ ("Nguyen Thi Mai": từ cuối không phải chữ cái đầu), số điện thoại, email, chữ số và dấu ngoặc; chữ cái đầu viết thiếu dấu chấm được chuẩn hóa thành "A.".
- **Ảnh** chỉ nhận link CDN Pancake đã được tin cậy (cùng luật với ảnh bảng size), tối đa 6 ảnh; link không hợp lệ bị từ chối, không bị bỏ im lặng.
- **Điểm trung bình, biểu đồ sao, tỉ lệ vừa vặn** do hệ thống tính từ các đánh giá đang hiển thị. Chỉ hiện khi có **từ 5 đánh giá** (`MIN_REVIEWS_FOR_SUMMARY`); dưới ngưỡng chỉ hiện từng đánh giá. Tỉ lệ vừa vặn cần ≥ 5 người trả lời.
- **Không phát `aggregateRating`/`Review` trong JSON-LD.** Đánh giá nhập tay không đủ điều kiện để đưa lên dữ liệu có cấu trúc; chỉ cân nhắc khi có luồng khách tự gửi gắn đơn.

## Hiển thị (trang sản phẩm)

1. Dưới tên: sao + điểm trung bình + "N đánh giá" (hoặc chỉ "N đánh giá" khi chưa đủ ngưỡng), cuộn tới khu đánh giá.
2. Dưới giá: thanh ảnh khách **của chính sản phẩm** (lấy từ ảnh trong đánh giá), chỉ khi có ≥ 3 ảnh.
3. Khu đánh giá: tổng quan, dải ảnh (có khung phóng to), bộ lọc (Tất cả / Có ảnh / 5 sao / 4 sao / 3 sao trở xuống), "Xem thêm đánh giá".
4. Sản phẩm có ảnh trong đánh giá thì **không** hiện thêm dải ảnh chung của thương hiệu (và link tới nó), tránh hai bức tường ảnh khách. Sản phẩm không có ảnh trong đánh giá giữ nguyên hành vi cũ.
5. Sản phẩm chưa có đánh giá đã đăng: trang không đổi gì.

## Quản trị

`/admin/products/<id>/reviews` (lối vào từ trang biên tập sản phẩm): thêm/sửa/ẩn-hiện/xóa. Xóa vĩnh viễn nằm sau một bước xác nhận riêng; ẩn là cách an toàn mặc định.

## Ngoài phạm vi v1

- Khách tự gửi đánh giá trên website (cần duyệt, chống spam, gắn đơn tự động, nơi lưu ảnh tải lên).
- Nhắc khách đánh giá sau khi nhận hàng.
- Nhập hàng loạt / nhập từ Facebook.
