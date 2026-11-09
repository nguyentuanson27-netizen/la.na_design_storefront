import { createTranslator, type Translator } from "../../i18n/translate.ts";

export type TryOnPrivacyDisclosure = Readonly<{
  summary: string;
  detail: string;
}>;

/** `flow-vertex`: Flow with Vertex as its overflow; one of the two serves each generation. */
export type TryOnDisclosureProvider = "vertex" | "flow" | "flow-vertex";

// The text is built from whole sentences passed to `t`, so each can be translated as one thought;
// the Vietnamese they join into is exactly what it always was.
const FLOW_DETAIL =
  "Google Flow được vận hành bằng một hồ sơ Chrome persistent để giữ phiên đăng nhập; browser storage/cache của hồ sơ này và dự án/lịch sử Google Flow có thể giữ lại dữ liệu theo hành vi của Chrome và Google. Vì vậy tính năng này không cam kết zero-retention đối với dữ liệu do trình duyệt hoặc Google quản lý.";
const VERTEX_RETENTION =
  "việc xử lý và lưu giữ tại Google Cloud tuân theo các thiết lập kiểm soát dữ liệu và điều khoản dịch vụ áp dụng.";

const IDENTITY: Translator = createTranslator("vi", {});

/**
 * Buyer-facing provider disclosure for the try-on dialog.
 *
 * This is a presentation model, not provider/runtime configuration: it intentionally owns no
 * credentials, env access or integration calls. The server decides the provider and passes only the
 * provider discriminator into the client presentation layer.
 *
 * With a Vertex overflow the shopper consents before anyone knows which of the two will serve them,
 * so the copy names both, says when Vertex is used, and says that one generation uses only one.
 */
export function resolveTryOnPrivacyDisclosure(
  provider: TryOnDisclosureProvider,
  brandName: string,
  t: Translator = IDENTITY,
): TryOnPrivacyDisclosure {
  const flowDetail = t(FLOW_DETAIL);
  const vertexRetention = t(VERTEX_RETENTION);
  if (provider === "flow-vertex") {
    return {
      summary: t(
        "{brandName} không ghi ảnh thử đồ vào database hay kho ảnh riêng; ảnh được xử lý qua Google Flow bằng một hồ sơ Chrome được lưu lâu dài, hoặc qua Google Cloud Vertex AI khi Google Flow đang bận hay tạm gián đoạn.",
        { brandName },
      ),
      detail:
        t(
          "{brandName} dùng file tạm cho ảnh nàng tải lên, ảnh sản phẩm và kết quả; các file tạm này được xóa sau request và không được ghi vào database hay object storage của cửa hàng.",
          { brandName },
        ) +
        " " +
        t("Mỗi lần tạo ảnh chỉ dùng một trong hai dịch vụ của Google.") +
        " " +
        t("Thường là Google Flow:") +
        ` ${flowDetail} ` +
        t("Khi Google Flow đang bận hoặc tạm gián đoạn, ảnh của nàng và ảnh sản phẩm được gửi tới Google Cloud Vertex AI thay thế;") +
        " " +
        vertexRetention,
    };
  }

  if (provider === "flow") {
    return {
      summary: t(
        "{brandName} không ghi ảnh thử đồ vào database hay kho ảnh riêng; ảnh được xử lý qua Google Flow bằng một hồ sơ Chrome được lưu lâu dài.",
        { brandName },
      ),
      detail:
        t(
          "{brandName} dùng file tạm cho ảnh nàng tải lên, ảnh sản phẩm và kết quả; các file tạm này được xóa sau request và không được ghi vào database hay object storage của cửa hàng.",
          { brandName },
        ) +
        " " +
        flowDetail,
    };
  }

  return {
    summary: t("{brandName} không lưu ảnh trong hệ thống của mình; ảnh được gửi tới Google Cloud Vertex AI để tạo kết quả.", {
      brandName,
    }),
    detail:
      t("{brandName} không lưu ảnh nàng tải lên hay ảnh được tạo trong hệ thống của mình.", { brandName }) +
      " " +
      t("Ảnh của nàng và ảnh sản phẩm được gửi tới Google Cloud Vertex AI để tạo kết quả;") +
      ` ${vertexRetention}`,
  };
}
