export type TryOnPrivacyDisclosure = Readonly<{
  summary: string;
  detail: string;
}>;

export type TryOnDisclosureProvider = "vertex" | "flow";

/**
 * Buyer-facing provider disclosure for the try-on dialog.
 *
 * This is a presentation model, not provider/runtime configuration: it intentionally owns no
 * credentials, env access or integration calls. The server decides the provider and passes only the
 * provider discriminator into the client presentation layer.
 */
export function resolveTryOnPrivacyDisclosure(
  provider: TryOnDisclosureProvider,
  brandName: string,
): TryOnPrivacyDisclosure {
  if (provider === "flow") {
    return {
      summary:
        `${brandName} không ghi ảnh thử đồ vào database hay kho ảnh riêng; ảnh được xử lý qua Google Flow bằng một hồ sơ Chrome được lưu lâu dài.`,
      detail:
        `${brandName} dùng file tạm cho ảnh bạn tải lên, ảnh sản phẩm và kết quả; các file tạm này được xóa sau request và không được ghi vào database hay object storage của cửa hàng. ` +
        "Google Flow được vận hành bằng một hồ sơ Chrome persistent để giữ phiên đăng nhập; " +
        "browser storage/cache của hồ sơ này và dự án/lịch sử Google Flow có thể giữ lại dữ liệu " +
        "theo hành vi của Chrome và Google. Vì vậy tính năng này không cam kết zero-retention đối " +
        "với dữ liệu do trình duyệt hoặc Google quản lý.",
    };
  }

  return {
    summary:
      `${brandName} không lưu ảnh trong hệ thống của mình; ảnh được gửi tới Google Cloud Vertex AI để tạo kết quả.`,
    detail:
      `${brandName} không lưu ảnh bạn tải lên hay ảnh được tạo trong hệ thống của chúng tôi. ` +
      "Ảnh của bạn và ảnh sản phẩm được gửi tới Google Cloud Vertex AI để tạo kết quả; việc xử lý " +
      "và lưu giữ tại Google Cloud tuân theo các thiết lập kiểm soát dữ liệu và điều khoản dịch vụ áp dụng.",
  };
}
