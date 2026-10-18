import { BRAND } from "@/brand";

/**
 * The About copy that the page, its metadata and its structured data all state.
 *
 * One place, so the visible FAQ and the FAQPage JSON-LD cannot drift apart, and so the brand name,
 * the support hours and the showroom address come from Brand Config rather than being typed again.
 */

const { opens, closes } = BRAND.contact.supportHours;

/** The showroom as the FAQ names it: street number and city, without the ward Brand Config adds. */
const SHOWROOM = `${BRAND.contact.streetAddress.split(",")[0]}, ${BRAND.contact.addressLocality}`;

export const ABOUT_DESCRIPTION = `Thành lập từ năm 2022, ${BRAND.identity.name} là thương hiệu thời trang nữ thiết kế cao cấp, nổi bật với áo dài cách tân 4 tà, đầm tiệc và set đồ thanh lịch, tôn vinh nét duyên Việt.`;

export const ABOUT_FAQ: readonly Readonly<{ question: string; answer: string }>[] = Object.freeze([
  {
    question: `${BRAND.identity.name} thành lập năm nào và chuyên về dòng sản phẩm gì?`,
    answer: `${BRAND.identity.name} thành lập từ năm 2022, là thương hiệu thời trang nữ thiết kế cao cấp chuyên về các dòng áo dài cách tân 4 tà, đầm dự tiệc và set đồ thanh lịch dành cho phái đẹp.`,
  },
  {
    question: "Khách hàng có thể đến thử đồ trực tiếp ở đâu?",
    answer: `Nàng có thể ghé thăm và trải nghiệm trực tiếp không gian thời trang tại Showroom ${BRAND.identity.name}: ${SHOWROOM} (mở cửa từ ${opens} đến ${closes} hàng ngày).`,
  },
  {
    question: "Tôi mua hàng online từ xa thì làm sao để chọn được size vừa vặn?",
    answer: `Nàng có thể trải nghiệm tính năng Thử đồ ảo AI ngay trên website, tham khảo bảng số đo chi tiết (ngực, eo, mông) hoặc nhắn tin trực tiếp qua hotline/Zalo ${BRAND.contact.telephone.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3")} để được chuyên viên tư vấn hỗ trợ chọn size chuẩn xác. La.na cũng áp dụng chính sách đổi size trong 15 ngày để nàng hoàn toàn yên tâm.`,
  },
]);
