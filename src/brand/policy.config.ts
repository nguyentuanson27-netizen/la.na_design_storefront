import { BRAND } from "./brand.config.ts";
import { FULFILLMENT } from "./fulfillment.config.ts";

export type PolicyContentSection = Readonly<{
  heading: string;
  paragraphs: readonly string[];
  items: readonly string[];
  /** Paragraphs that follow a list when the approved source places concluding text after it. */
  closingParagraphs?: readonly string[];
}>;

export type PolicyOwnedContent = Readonly<{
  detail: string;
  note: string | null;
  sections: readonly PolicyContentSection[];
}>;

const WEBSITE_HOST = "www.lanadesign.vn";
const BUSINESS_ADDRESS = `${BRAND.contact.streetAddress}, ${BRAND.contact.addressLocality}`;
const SUPPORT_HOURS = `${BRAND.contact.supportHours.opens} - ${BRAND.contact.supportHours.closes} hằng ngày (${BRAND.contact.supportHours.utcOffsetLabel})`;

/**
 * A7b — owner-approved policy text normalized in
 * `docs/specs/la-na-design-policy-authority.md`.
 *
 * Two explicit owner overrides are applied while transcribing the supplied terms:
 * - website payment is COD only; wording that offered bank transfer as a payment method is replaced
 *   by the current COD fact from `FULFILLMENT.payment`;
 * - contact placeholders are replaced by Brand Config facts, and no contact-form channel is
 *   published before G3/F9b provides real outbound delivery.
 *
 * This module stores policy facts only. JSX may label/group them, but must not author legal clauses.
 */
export const POLICY_CONTENT = {
  "ho-tro-truc-tuyen": {
    detail: "La.na Design hỗ trợ khách hàng qua các kênh trực tuyến và liên hệ chính thức như:",
    note: null,
    sections: [
      {
        heading: "Kênh hỗ trợ",
        paragraphs: [],
        items: [
          `Website: ${WEBSITE_HOST}`,
          `Hotline/Zalo: ${BRAND.contact.telephone}`,
          `Email: ${BRAND.contact.email}`,
          `Fanpage: ${BRAND.contact.fanpageUrl}`,
          `Thời gian hỗ trợ dự kiến: ${SUPPORT_HOURS}`,
        ],
      },
      {
        heading: "Nội dung hỗ trợ",
        paragraphs: [],
        items: [
          "Tư vấn sản phẩm, size, màu sắc và cách đặt hàng.",
          "Kiểm tra tình trạng đơn hàng.",
          "Hỗ trợ thanh toán, giao nhận.",
          "Tiếp nhận đổi trả, hoàn tiền và khiếu nại.",
          "Cung cấp thông tin về chương trình ưu đãi, chính sách bán hàng và dịch vụ khách hàng.",
        ],
      },
    ],
  },
  "khieu-nai": {
    detail: "La.na Design tiếp nhận phản ánh, yêu cầu và khiếu nại của khách hàng qua các kênh:",
    note: FULFILLMENT.support.complaintResponseNote,
    sections: [
      {
        heading: "Kênh tiếp nhận",
        paragraphs: [],
        items: [
          `Hotline/Zalo: ${BRAND.contact.telephone}`,
          `Email: ${BRAND.contact.email}`,
          `Fanpage/kênh chăm sóc khách hàng chính thức: ${BRAND.contact.fanpageUrl}`,
        ],
      },
      {
        heading: "Quy trình xử lý khiếu nại",
        paragraphs: [],
        items: [
          "Bước 1: Khách hàng gửi phản ánh/khiếu nại kèm thông tin đơn hàng, nội dung vấn đề và hình ảnh/video chứng minh nếu có.",
          "Bước 2: La.na Design tiếp nhận và xác minh thông tin.",
          `Bước 3: La.na Design phản hồi hướng xử lý trong thời gian hợp lý, thông thường ${FULFILLMENT.support.complaintResponseNote}`,
          "Bước 4: Hai bên phối hợp thực hiện phương án xử lý đã thống nhất.",
          "Bước 5: Trường hợp phát sinh tranh chấp không thể giải quyết bằng thương lượng, hai bên có thể đưa vụ việc đến cơ quan có thẩm quyền theo quy định pháp luật Việt Nam.",
        ],
      },
    ],
  },
  "dieu-khoan-chung": {
    detail:
      "Tài liệu này quy định các điều khoản sử dụng, chính sách bán hàng, thanh toán, giao nhận, đổi trả, hoàn tiền, bảo mật thông tin và hỗ trợ khách hàng khi khách hàng truy cập, đặt hàng hoặc sử dụng dịch vụ trên website bán hàng điện tử của La.na Design.",
    note: null,
    sections: [
      {
        heading: "Thông tin đơn vị bán hàng",
        paragraphs: [],
        items: [
          `Website: ${WEBSITE_HOST}`,
          `Địa chỉ kinh doanh: ${BUSINESS_ADDRESS}`,
          `Hotline/Zalo hỗ trợ: ${BRAND.contact.telephone}`,
          `Email hỗ trợ: ${BRAND.contact.email}`,
          `Mã số thuế/Giấy chứng nhận đăng ký kinh doanh nếu có: ${BRAND.identity.taxId}`,
        ],
      },
      {
        heading: "Phạm vi áp dụng",
        paragraphs: [
          "Điều khoản này áp dụng cho toàn bộ khách hàng truy cập, tham khảo thông tin, đặt mua sản phẩm hoặc sử dụng các tiện ích, dịch vụ được cung cấp trên website của La.na Design.",
          "Khi truy cập hoặc đặt hàng trên website, khách hàng được hiểu là đã đọc, hiểu và đồng ý với các điều khoản được nêu trong tài liệu này.",
        ],
        items: [],
      },
      {
        heading: "Sản phẩm và dịch vụ cung cấp",
        paragraphs: [
          "La.na Design kinh doanh các sản phẩm thời trang nữ, bao gồm nhưng không giới hạn ở: áo dài, áo dài cách tân, váy, set đồ, phụ kiện thời trang và các sản phẩm liên quan khác do La.na Design phân phối.",
          "Thông tin sản phẩm được thể hiện trên website có thể bao gồm: tên sản phẩm, hình ảnh, màu sắc, kích cỡ, chất liệu, mô tả thiết kế, giá bán, tình trạng còn hàng, chính sách ưu đãi và các thông tin liên quan khác.",
          "La.na Design cố gắng thể hiện thông tin sản phẩm chính xác nhất có thể. Tuy nhiên, màu sắc sản phẩm có thể có sai lệch nhẹ do ánh sáng chụp ảnh, màn hình hiển thị hoặc từng lô chất liệu.",
        ],
        items: [],
      },
      {
        heading: "Quy trình đặt hàng và xác nhận đơn hàng",
        paragraphs: ["Khách hàng có thể đặt hàng trên website theo các bước cơ bản sau:"],
        items: [
          "Bước 1: Lựa chọn sản phẩm, màu sắc, kích cỡ và số lượng.",
          "Bước 2: Thêm sản phẩm vào giỏ hàng hoặc chọn mua ngay.",
          "Bước 3: Điền thông tin nhận hàng, bao gồm họ tên, số điện thoại, địa chỉ nhận hàng và các ghi chú nếu có.",
          "Bước 4: Lựa chọn phương thức thanh toán và phương thức giao hàng phù hợp.",
          "Bước 5: Kiểm tra lại thông tin đơn hàng và xác nhận đặt hàng.",
          "Bước 6: La.na Design tiếp nhận, kiểm tra và xác nhận đơn hàng qua hệ thống, điện thoại, tin nhắn hoặc email.",
        ],
        closingParagraphs: [
          "Đơn hàng chỉ được xem là hợp lệ sau khi La.na Design xác nhận thành công. Trong trường hợp thông tin đơn hàng chưa rõ ràng, La.na Design có thể liên hệ lại để xác minh trước khi xử lý.",
        ],
      },
      {
        heading: "Chính sách thanh toán",
        paragraphs: [FULFILLMENT.payment.codNote],
        items: [],
      },
      {
        heading: "Quyền sở hữu trí tuệ",
        paragraphs: [
          "Toàn bộ nội dung trên website của La.na Design, bao gồm nhưng không giới hạn ở hình ảnh, video, thiết kế, logo, tên thương hiệu, bài viết, mô tả sản phẩm, giao diện và các tài liệu liên quan, thuộc quyền sở hữu hoặc quyền sử dụng hợp pháp của La.na Design.",
          "Mọi hành vi sao chép, sử dụng, chỉnh sửa, phân phối hoặc khai thác nội dung từ website mà không có sự đồng ý bằng văn bản của La.na Design đều có thể bị xử lý theo quy định pháp luật.",
        ],
        items: [],
      },
      {
        heading: "Giới hạn trách nhiệm",
        paragraphs: ["La.na Design không chịu trách nhiệm đối với các thiệt hại phát sinh do:"],
        items: [
          "Khách hàng cung cấp sai thông tin đặt hàng, giao nhận hoặc thanh toán.",
          "Khách hàng sử dụng sản phẩm sai hướng dẫn bảo quản, giặt ủi hoặc sử dụng không đúng mục đích.",
          "Sự cố đến từ bên thứ ba như đơn vị vận chuyển, cổng thanh toán, nhà cung cấp dịch vụ internet hoặc nền tảng kỹ thuật ngoài phạm vi kiểm soát hợp lý của La.na Design.",
          "Trường hợp bất khả kháng như thiên tai, dịch bệnh, hỏa hoạn, sự cố hệ thống, thay đổi chính sách từ cơ quan nhà nước hoặc các sự kiện ngoài khả năng kiểm soát.",
        ],
      },
      {
        heading: "Thay đổi điều khoản",
        paragraphs: [
          "La.na Design có quyền cập nhật, điều chỉnh hoặc bổ sung điều khoản và chính sách này để phù hợp với hoạt động kinh doanh, trải nghiệm khách hàng và quy định pháp luật tại từng thời điểm.",
          "Phiên bản cập nhật sẽ được đăng tải trên website và có hiệu lực kể từ thời điểm được công bố, trừ khi có thông báo khác.",
          "Khách hàng nên thường xuyên kiểm tra điều khoản và chính sách trên website để cập nhật thông tin mới nhất.",
        ],
        items: [],
      },
      {
        heading: "Luật áp dụng và giải quyết tranh chấp",
        paragraphs: [
          "Điều khoản này được điều chỉnh và giải thích theo quy định pháp luật Việt Nam.",
          "Mọi tranh chấp phát sinh giữa khách hàng và La.na Design sẽ được ưu tiên giải quyết thông qua thương lượng, hòa giải trên tinh thần thiện chí.",
          "Trường hợp không thể giải quyết bằng thương lượng, tranh chấp sẽ được đưa ra cơ quan có thẩm quyền tại Việt Nam để xử lý theo quy định pháp luật.",
        ],
        items: [],
      },
      {
        heading: "Hiệu lực áp dụng",
        paragraphs: [
          "Điều khoản và chính sách này có hiệu lực kể từ ngày được La.na Design đăng tải trên website.",
          "Khách hàng tiếp tục truy cập, sử dụng website hoặc đặt hàng sau khi điều khoản được công bố đồng nghĩa với việc khách hàng đã đọc, hiểu và đồng ý với các nội dung trong tài liệu này.",
        ],
        items: [],
      },
    ],
  },
  "chinh-sach-gia": {
    detail: "Giá sản phẩm được niêm yết công khai trên website tại thời điểm khách hàng đặt hàng.",
    note: null,
    sections: [
      {
        heading: "Chính sách giá",
        paragraphs: [
          "Giá bán có thể thay đổi tùy từng thời điểm, chương trình khuyến mại hoặc chính sách bán hàng của La.na Design. Mức giá áp dụng cho đơn hàng là mức giá được xác nhận tại thời điểm khách hàng hoàn tất đặt hàng và được La.na Design xác nhận.",
          "Giá sản phẩm chưa bao gồm phí vận chuyển, trừ khi website hoặc chương trình khuyến mại có thông báo khác.",
          "La.na Design có quyền điều chỉnh giá bán, chương trình ưu đãi hoặc chính sách khuyến mại mà không cần thông báo trước, nhưng không làm ảnh hưởng đến các đơn hàng đã được xác nhận trước đó, trừ trường hợp có lỗi hiển thị giá bất thường hoặc sai sót kỹ thuật rõ ràng.",
        ],
        items: [],
      },
    ],
  },
  "bao-mat": {
    detail: "La.na Design có thể thu thập thông tin cá nhân của khách hàng nhằm:",
    note: null,
    sections: [
      {
        heading: "11.1. Mục đích thu thập thông tin",
        paragraphs: [],
        items: [
          "Xử lý đơn hàng và giao hàng.",
          "Liên hệ xác nhận đơn hàng, hỗ trợ đổi trả, bảo hành hoặc giải quyết khiếu nại.",
          "Cung cấp thông tin về sản phẩm, chương trình ưu đãi hoặc dịch vụ chăm sóc khách hàng khi khách hàng đồng ý.",
          "Cải thiện chất lượng dịch vụ, trải nghiệm mua sắm và hoạt động vận hành website.",
          "Thực hiện các nghĩa vụ theo quy định pháp luật khi cần thiết.",
        ],
      },
      {
        heading: "11.2. Phạm vi thông tin thu thập",
        paragraphs: ["Thông tin có thể bao gồm:"],
        items: [
          "Họ và tên.",
          "Số điện thoại.",
          "Email.",
          "Địa chỉ nhận hàng.",
          "Thông tin đơn hàng, lịch sử mua hàng và nội dung trao đổi với bộ phận hỗ trợ.",
          "Thông tin thanh toán cần thiết để xác nhận giao dịch, không bao gồm các dữ liệu nhạy cảm mà La.na Design không được phép lưu trữ theo quy định của đơn vị thanh toán.",
        ],
      },
      {
        heading: "11.3. Phạm vi sử dụng thông tin",
        paragraphs: [
          "Thông tin khách hàng chỉ được sử dụng trong phạm vi phục vụ hoạt động bán hàng, chăm sóc khách hàng, giao nhận, xử lý đổi trả, giải quyết khiếu nại và các mục đích hợp pháp khác được nêu trong chính sách này.",
          "La.na Design không bán, trao đổi hoặc chia sẻ trái phép thông tin cá nhân của khách hàng cho bên thứ ba, trừ các trường hợp cần thiết như:",
        ],
        items: [
          "Đơn vị vận chuyển để giao hàng.",
          "Đơn vị thanh toán để xử lý giao dịch.",
          "Đơn vị kỹ thuật vận hành website, lưu trữ dữ liệu hoặc chăm sóc khách hàng theo thỏa thuận bảo mật.",
          "Cơ quan nhà nước có thẩm quyền khi có yêu cầu hợp pháp.",
        ],
      },
      {
        heading: "11.4. Thời gian lưu trữ thông tin",
        paragraphs: [
          "Thông tin cá nhân của khách hàng được lưu trữ trong thời gian cần thiết để phục vụ mục đích thu thập, xử lý đơn hàng, chăm sóc khách hàng, giải quyết khiếu nại hoặc theo thời hạn pháp luật yêu cầu.",
        ],
        items: [],
      },
      {
        heading: "11.5. Quyền của khách hàng đối với thông tin cá nhân",
        paragraphs: [
          "Khách hàng có quyền yêu cầu kiểm tra, cập nhật, chỉnh sửa hoặc xóa thông tin cá nhân của mình trong phạm vi phù hợp với quy định pháp luật và khả năng vận hành của La.na Design.",
          "Khách hàng có thể gửi yêu cầu qua hotline, email hoặc kênh hỗ trợ chính thức của La.na Design.",
        ],
        items: [],
      },
      {
        heading: "11.6. Cam kết bảo mật",
        paragraphs: [
          "La.na Design áp dụng các biện pháp phù hợp để bảo vệ thông tin cá nhân của khách hàng, hạn chế truy cập trái phép, mất mát, rò rỉ hoặc sử dụng sai mục đích.",
          "Trong trường hợp hệ thống có sự cố ảnh hưởng đến dữ liệu khách hàng, La.na Design sẽ phối hợp xử lý và thông báo theo quy định pháp luật hiện hành nếu cần thiết.",
        ],
        items: [],
      },
    ],
  },
  "dieu-kien-cung-cap": {
    detail:
      "La.na Design chỉ cung cấp các sản phẩm thuộc phạm vi kinh doanh hợp pháp và phù hợp với quy định pháp luật Việt Nam.",
    note: null,
    sections: [
      {
        heading: "Các điều kiện hoặc hạn chế trong việc cung cấp hàng hóa/dịch vụ",
        paragraphs: [
          "Việc cung cấp sản phẩm có thể phụ thuộc vào tình trạng tồn kho, thời gian xử lý đơn hàng, khu vực giao hàng, điều kiện vận chuyển và các yếu tố khách quan khác.",
          "La.na Design có quyền từ chối hoặc hủy đơn hàng trong các trường hợp:",
        ],
        items: [
          "Sản phẩm đã hết hàng hoặc không thể tiếp tục cung cấp.",
          "Thông tin đặt hàng không đầy đủ, không chính xác hoặc không thể liên hệ xác nhận.",
          "Đơn hàng có dấu hiệu gian lận, gây ảnh hưởng đến quyền lợi của La.na Design hoặc khách hàng khác.",
          "Khách hàng không tuân thủ các điều khoản mua hàng, thanh toán, nhận hàng hoặc chính sách đổi trả.",
          "Trường hợp bất khả kháng như thiên tai, dịch bệnh, sự cố vận chuyển, sự cố hệ thống hoặc các nguyên nhân ngoài khả năng kiểm soát hợp lý của La.na Design.",
        ],
      },
    ],
  },
  "quyen-nghia-vu": {
    detail: "Khách hàng có trách nhiệm:",
    note: null,
    sections: [
      {
        heading: "Trách nhiệm của khách hàng",
        paragraphs: [],
        items: [
          "Cung cấp thông tin đầy đủ, chính xác khi đặt hàng.",
          "Kiểm tra kỹ thông tin sản phẩm, size, màu sắc, số lượng và địa chỉ nhận hàng trước khi xác nhận đơn.",
          "Thanh toán đầy đủ theo phương thức đã lựa chọn.",
          "Phối hợp với đơn vị vận chuyển để nhận hàng đúng thời gian.",
          "Sử dụng website đúng mục đích, không can thiệp, phá hoại, sao chép trái phép hoặc thực hiện các hành vi gây ảnh hưởng đến hoạt động của website.",
          "Tuân thủ các điều khoản, chính sách và hướng dẫn được công bố trên website của La.na Design.",
        ],
      },
      {
        heading: "Trách nhiệm của La.na Design",
        paragraphs: ["La.na Design có trách nhiệm:"],
        items: [
          "Cung cấp thông tin sản phẩm, giá bán và chính sách mua hàng rõ ràng trên website.",
          "Xử lý đơn hàng theo đúng thông tin đã xác nhận với khách hàng.",
          "Bảo vệ thông tin cá nhân của khách hàng theo chính sách bảo mật.",
          "Tiếp nhận và xử lý yêu cầu, phản ánh, khiếu nại của khách hàng trong phạm vi trách nhiệm hợp lý.",
          "Thực hiện chính sách đổi trả, hoàn tiền theo các điều kiện đã công bố.",
        ],
      },
    ],
  },
} as const satisfies Record<string, PolicyOwnedContent>;
