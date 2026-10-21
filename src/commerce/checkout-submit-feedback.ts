import type { GuestCheckoutSubmitResult } from "./guest-checkout-submit.ts";
import { BRAND } from "../brand/index.ts";
import { VIETNAM_PHONE_ERROR } from "./vietnam-phone.ts";

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

/**
 * `submittedTotalVnd` is the total of the render the buyer submitted against -- itself a server number,
 * read from that render, never computed here. With it a price change reads "old → new"; without it (or
 * when the two agree) only the new total is stated.
 */
export function checkoutSubmitFeedback(
  result: GuestCheckoutSubmitResult,
  context: Readonly<{ submittedTotalVnd?: number }> = {},
): CheckoutSubmitFeedback {
  if (result.ok) {
    return {
      tone: "success",
      title: "Đặt hàng thành công",
      message: `Mã đơn ${result.orderCode}. ${BRAND.identity.name} sẽ liên hệ để xác nhận đơn COD.`,
      mayRetry: false,
    };
  }

  if (result.status === "RETRYABLE" && result.giftRepairRequired) {
    return { tone: "warning", title: "Kiểm tra lại quà đã chọn", message: "Quà tặng nàng chọn vừa có thay đổi về tồn kho hoặc chương trình. Nàng chỉ cần bỏ quà cũ bên dưới và chọn lại; thông tin nhận hàng vẫn được giữ nguyên.", mayRetry: true };
  }

  // The buyer is being asked to accept a price they have not seen yet, so this is the one failure
  // that must state the new number and stay retryable. Every unproven-proof outcome lands here;
  // from the buyer's side there is nothing to distinguish and only one thing to do.
  if (result.status === "PRICE_CHANGED" && result.priceChange.requires === "NONCLAIM_ACKNOWLEDGEMENT") {
    // GQ19 -- the quote is fine; what is missing is the buyer's explicit submit intent for the gift slots they are
    // not taking. The refreshed page shows the current quote and requires another explicit submit.
    return {
      tone: "warning",
      title: "Cần xác nhận quà tặng",
      message: `Đơn còn suất quà chưa nhận. Nàng xem lại quà rồi bấm “Đặt hàng COD” để đặt với tổng thanh toán ${vnd.format(result.priceChange.totalVnd)} nhé.`,
      mayRetry: true,
    };
  }

  if (result.status === "PRICE_CHANGED") {
    const previous = context.submittedTotalVnd;
    return {
      tone: "warning",
      title: "Giá đã thay đổi",
      message: previous !== undefined && Number.isSafeInteger(previous) && previous !== result.priceChange.totalVnd
        ? `Tổng thanh toán: ${vnd.format(previous)} → ${vnd.format(result.priceChange.totalVnd)}. Nàng xem lại đơn rồi bấm “Đặt hàng COD” để xác nhận nhé.`
        : `Tổng thanh toán hiện tại là ${vnd.format(result.priceChange.totalVnd)}. Nàng xem lại đơn rồi bấm “Đặt hàng COD” để xác nhận nhé.`,
      mayRetry: true,
    };
  }

  if (result.status === "PROCESSING") {
    return {
      tone: "warning",
      title: "Đơn hàng đang được xử lý",
      message: `Mã đơn ${result.orderCode} đang được xử lý. Nàng đừng gửi lại đơn nhé, để không tạo đơn trùng.`,
      mayRetry: false,
    };
  }

  if (result.status === "SYNC_UNKNOWN") {
    return {
      tone: "warning",
      title: "Chưa xác định trạng thái đồng bộ",
      message: `${BRAND.identity.name} đã nhận mã đơn ${result.orderCode} và đang kiểm tra lại. Nàng đừng gửi lại đơn nhé; ${BRAND.identity.name} sẽ liên hệ xác nhận với nàng.`,
      mayRetry: false,
    };
  }

  switch (result.reason) {
    case "INVALID_INPUT":
      return {
        tone: "error",
        title: "Kiểm tra lại thông tin",
        message:
          "Địa chỉ hoặc thông tin nhận hàng chưa đúng. Nàng chọn lại tỉnh/thành phố, phường/xã rồi kiểm tra lại số nhà, tên đường nhé.",
        mayRetry: true,
      };
    case "INVALID_PHONE":
      return {
        tone: "error",
        title: "Số điện thoại chưa đúng",
        message: VIETNAM_PHONE_ERROR,
        mayRetry: true,
      };
    case "CART_CHANGED":
      return {
        tone: "warning",
        title: "Giỏ hàng đã thay đổi",
        message:
          "Giá hoặc tồn kho vừa thay đổi. Nàng quay lại giỏ hàng xem lại trước khi đặt nhé.",
        mayRetry: false,
      };
    case "CART_UNAVAILABLE":
      return {
        tone: "warning",
        title: "Giỏ hàng không còn sẵn sàng",
        message: "Giỏ hàng hiện chưa thể thanh toán. Nàng quay lại giỏ hàng xem lại sản phẩm nhé.",
        mayRetry: false,
      };
    case "SERVICE_UNAVAILABLE":
    case "CHECKOUT_UNAVAILABLE":
      return {
        tone: "error",
        title: "Chưa thể đặt hàng",
        message: "Hệ thống đặt hàng đang tạm gián đoạn. Nàng thử lại sau ít phút nhé.",
        mayRetry: true,
      };
  }
}
