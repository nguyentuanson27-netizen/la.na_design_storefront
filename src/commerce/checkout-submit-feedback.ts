import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";
import { BRAND } from "../brand/index.ts";

const vnd = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

export type CheckoutSubmitFeedback = Readonly<{
  tone: "success" | "error" | "warning";
  title: string;
  message: string;
  mayRetry: boolean;
}>;

export function checkoutSubmitFeedback(
  result: GuestCheckoutSubmitResult,
): CheckoutSubmitFeedback {
  if (result.ok) {
    return {
      tone: "success",
      title: "Đặt hàng thành công",
      message: `Mã đơn ${result.orderCode}. ${BRAND.identity.name} sẽ liên hệ để xác nhận đơn COD.`,
      mayRetry: false,
    };
  }

  // The buyer is being asked to accept a price they have not seen yet, so this is the one failure
  // that must state the new number and stay retryable. Every unproven-proof outcome lands here;
  // from the buyer's side there is nothing to distinguish and only one thing to do.
  if (result.status === "PRICE_CHANGED") {
    return {
      tone: "warning",
      title: "Giá đã thay đổi",
      message: `Tổng thanh toán hiện tại là ${vnd.format(result.priceChange.totalVnd)}. Vui lòng xác nhận lại để đặt hàng với mức giá này.`,
      mayRetry: true,
    };
  }

  if (result.status === "PROCESSING") {
    return {
      tone: "warning",
      title: "Đơn hàng đang được xử lý",
      message: `Mã đơn ${result.orderCode} đang được xử lý. Vui lòng không gửi lại đơn để tránh tạo yêu cầu trùng.`,
      mayRetry: false,
    };
  }

  if (result.status === "SYNC_UNKNOWN") {
    return {
      tone: "warning",
      title: "Chưa xác định trạng thái đồng bộ",
      message: `Mã đơn ${result.orderCode} đã được tiếp nhận nhưng chưa xác định trạng thái tại Pancake. Vui lòng không gửi lại đơn; ${BRAND.identity.name} sẽ kiểm tra và liên hệ xác nhận.`,
      mayRetry: false,
    };
  }

  switch (result.reason) {
    case "INVALID_INPUT":
      return {
        tone: "error",
        title: "Kiểm tra lại thông tin",
        message:
          "Địa chỉ hoặc thông tin nhận hàng chưa hợp lệ. Hãy chọn lại đầy đủ tỉnh/thành, quận/huyện và phường/xã.",
        mayRetry: true,
      };
    case "CART_CHANGED":
      return {
        tone: "warning",
        title: "Giỏ hàng đã thay đổi",
        message:
          "Giá hoặc tồn kho đã thay đổi. Hãy quay lại giỏ hàng để kiểm tra trước khi đặt lại.",
        mayRetry: false,
      };
    case "CART_UNAVAILABLE":
      return {
        tone: "warning",
        title: "Giỏ hàng không còn sẵn sàng",
        message: "Giỏ hàng hiện không thể thanh toán. Hãy quay lại giỏ hàng và kiểm tra sản phẩm.",
        mayRetry: false,
      };
    case "SERVICE_UNAVAILABLE":
    case "CHECKOUT_UNAVAILABLE":
      return {
        tone: "error",
        title: "Chưa thể đặt hàng",
        message: "Hệ thống thanh toán đang tạm thời không sẵn sàng. Bạn có thể thử lại sau.",
        mayRetry: true,
      };
  }
}
