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
        `${brandName} không lưu ảnh trong hệ thống của mình; ảnh được gửi tới Google Flow để tạo kết quả.`,
      detail:
        `${brandName} không lưu ảnh bạn tải lên hay ảnh được tạo trong hệ thống của chúng tôi. ` +
        "Ảnh của bạn và ảnh sản phẩm được gửi tới Google Flow để tạo kết quả. " +
        "Google Flow có cơ chế dự án/lịch sử; nội dung đã tải lên hoặc tạo ra có thể xuất hiện " +
        "trong dự án hoặc lịch sử của tài khoản Google vận hành tính năng. Việc xử lý và lưu giữ " +
        "tại Google tuân theo điều khoản dịch vụ áp dụng.",
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
