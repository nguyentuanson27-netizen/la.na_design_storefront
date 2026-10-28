/** URL reason codes never become arbitrary user-visible text: unknown codes get the generic line. */
const reasons: Readonly<Record<string, string>> = {
  NOT_FOUND: "Không tìm thấy voucher.",
  STALE_REVISION: "Voucher đã thay đổi. Tải lại và kiểm tra trước khi lưu.",
  TARGET_INVALID: "Một số sản phẩm không tồn tại hoặc không thuộc cửa hàng.",
  LIMIT_REACHED: "Đã đạt giới hạn 50 voucher đang bật. Tắt voucher cũ trước khi bật thêm.",
  WINDOW_ENDED: "Voucher đã hết hạn. Sửa lịch trước khi bật.",
  CODE_TAKEN: "Mã này đã được dùng ở voucher hoặc loại voucher khác. Chọn mã khác.",
  TYPE_NOT_FOUND: "Không tìm thấy loại voucher.",
  TYPE_LIMIT_REACHED: "Đã đạt giới hạn 6 loại voucher. Gộp hoặc dùng lại loại cũ.",
  IDENTITY_LOCKED: "Loại voucher, cách phát hành, hiển thị và mã không đổi được sau khi đã bật. Hãy sao chép thành voucher mới.",
  NOT_EDITABLE: "Voucher đã kết thúc hoặc đã chạy rồi tắt nên chỉ đọc. Hãy sao chép thành voucher mới.",
  NOT_RE_ENABLEABLE: "Voucher đã từng chạy nên không bật lại được. Hãy sao chép thành voucher mới.",
  ALREADY_IN_STATE: "Voucher đã ở trạng thái này.",
  CAP_BELOW_COMMITTED: "Giới hạn mới thấp hơn lượt/ngân sách đã dùng hoặc đang được giữ cho khách.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
  VALIDATION: "Thông tin voucher chưa hợp lệ.",
};

const issues: Readonly<Record<string, string>> = {
  "name-invalid": "Tên voucher phải có từ 1 đến 120 ký tự.",
  "kind-invalid": "Chọn loại voucher: giảm tiền hàng hoặc miễn phí vận chuyển.",
  "issuance-invalid": "Chọn cách phát hành: tự động hoặc nhập mã.",
  "visibility-invalid": "Chọn hiển thị: công khai hoặc riêng tư.",
  "private-requires-code": "Voucher riêng tư phải dùng mã; voucher tự động luôn công khai.",
  "code-required": "Voucher dùng mã cần có mã.",
  "code-invalid": "Mã gồm 3–32 ký tự A–Z, 0–9, gạch ngang hoặc gạch dưới.",
  "code-not-allowed": "Voucher tự động không có mã.",
  "min-subtotal-invalid": "Giá trị đơn tối thiểu phải là số nguyên đồng lớn hơn 0.",
  "discount-required": "Nhập mức giảm.",
  "discount-not-allowed": "Voucher vận chuyển không có mức giảm tiền hàng.",
  "discount-type-invalid": "Chọn kiểu giảm: số tiền cố định hoặc phần trăm.",
  "discount-fields-mismatch": "Mức giảm có trường không khớp với kiểu giảm đã chọn.",
  "fixed-amount-invalid": "Số tiền giảm phải là số nguyên đồng lớn hơn 0.",
  "fixed-min-required": "Giảm số tiền cố định bắt buộc có giá trị đơn tối thiểu.",
  "fixed-min-not-above-amount": "Giá trị đơn tối thiểu phải lớn hơn số tiền giảm.",
  "percent-invalid": "Phần trăm giảm phải là số nguyên từ 1 đến 99.",
  "max-discount-invalid": "Mức giảm tối đa phải là số nguyên đồng lớn hơn 0.",
  "window-invalid": "Kiểm tra thời gian: mốc kết thúc phải sau mốc bắt đầu.",
  "max-uses-invalid": "Tổng số lượt dùng phải là số nguyên lớn hơn 0.",
  "max-budget-invalid": "Ngân sách tối đa phải là số nguyên đồng lớn hơn 0.",
  "scope-mode-invalid": "Chọn phạm vi áp dụng.",
  "scope-all-shop-with-targets": "Phạm vi toàn shop không đi kèm danh mục hay sản phẩm thêm riêng; chỉ có thể loại trừ sản phẩm.",
  "scope-empty": "Phạm vi theo danh mục/sản phẩm cần chọn ít nhất một danh mục hoặc sản phẩm.",
  "scope-category-unknown": "Danh mục không hợp lệ.",
  "scope-category-too-many": "Chọn tối đa 50 danh mục.",
  "scope-included-too-many": "Thêm tối đa 500 sản phẩm.",
  "scope-excluded-too-many": "Loại trừ tối đa 500 sản phẩm.",
  "scope-product-id-invalid": "Danh sách sản phẩm không hợp lệ.",
  "scope-duplicate-entry": "Có mục bị trùng trong danh sách.",
  "type-invalid": "Loại voucher không hợp lệ.",
  "type-not-allowed": "Voucher vận chuyển không thuộc loại voucher nào.",
  "type-priority-invalid": "Thứ tự áp dụng phải là số nguyên từ 1 đến 1000 (số nhỏ được áp dụng trước).",
  "ladder-conflict": "Mốc này trùng hoặc không có lợi hơn một mốc khác đang bật của cùng loại: mốc cao hơn phải giảm nhiều hơn (với giảm % thì phần trăm và mức giảm tối đa đều không được thấp hơn) và hai mốc không được cùng ngưỡng.",
  "input-invalid": "Thông tin voucher chưa hợp lệ.",
};

const generic = "Chưa lưu được voucher. Tải lại để kiểm tra trạng thái và thử lại.";

export function describeVoucherAdminReason(reason: string, issue?: string): string {
  if (reason === "VALIDATION" && issue !== undefined && Object.hasOwn(issues, issue)) return issues[issue]!;
  return Object.hasOwn(reasons, reason) ? reasons[reason]! : generic;
}
