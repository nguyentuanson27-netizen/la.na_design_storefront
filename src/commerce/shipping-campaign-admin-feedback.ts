/** URL reason codes never become arbitrary user-visible error text. */
const messages: Readonly<Record<string, string>> = {
  NAME_INVALID: "Tên chiến dịch phải có từ 1 đến 120 ký tự.",
  WINDOW_INVALID: "Kiểm tra thời gian: mốc kết thúc phải sau mốc bắt đầu.",
  QUANTITY_INVALID: "Số lượng mua tối thiểu phải là số nguyên từ 1 đến 10.000.",
  PRIORITY_INVALID: "Thứ tự ưu tiên phải là số nguyên từ 0 đến 1.000.000.",
  STACKING_INVALID: "Lựa chọn cộng dồn không hợp lệ.",
  SCOPE_INVALID: "Chọn danh mục hoặc sản phẩm hợp lệ, không trùng lặp và không vượt giới hạn.",
  NOT_FOUND: "Không tìm thấy chiến dịch.",
  STALE_REVISION: "Chiến dịch đã thay đổi. Tải lại và kiểm tra trước khi lưu.",
  TARGET_INVALID: "Một số sản phẩm không tồn tại hoặc không thuộc cửa hàng.",
  LIMIT_REACHED: "Đã đạt giới hạn 50 chiến dịch đang bật. Tắt chiến dịch cũ trước khi bật thêm.",
  WINDOW_ENDED: "Chiến dịch đã hết hạn. Sửa lịch trước khi bật.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
};
export function describeShippingAdminReason(reason: string): string {
  return Object.hasOwn(messages, reason) ? messages[reason]! : "Chưa lưu được chiến dịch. Tải lại để kiểm tra trạng thái và thử lại.";
}
