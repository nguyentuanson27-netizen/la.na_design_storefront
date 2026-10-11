import Link from "next/link";

import { BRAND } from "@/brand";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadAboutRoute, type AboutRouteProps } from "@/routes/about";
import type { AboutViewModel } from "@/routes/evergreen-model";
import { buildAboutMetadata } from "@/routes/metadata/about";

function render(data: AboutViewModel) {
  return (
    <PageShell>
      <PageBreadcrumbs
        items={[{ label: "Trang chủ", href: "/" }, { label: "Về La.na Design" }]}
      />
      <PageHeader
        eyebrow="Thương hiệu thời trang nữ thiết kế"
        title={`Về ${BRAND.identity.name}`}
        lead={data.positioning}
      />

      {/* Quote Banner */}
      <div className="mt-8 rounded-lg border border-[#8B5E3C]/20 bg-[#FDFBF9] p-6 text-center md:p-8">
        <blockquote className="font-display text-xl italic tracking-[-0.01em] text-[#8B5E3C] md:text-2xl">
          “Charismatic in every yard of cloth”
        </blockquote>
        <p className="mt-3 text-sm text-black/70 md:text-base">
          Đánh thức vẻ đẹp tự tin, thanh tao và kiêu hãnh của người phụ nữ hiện đại qua ngôn ngữ thời trang tinh tế.
        </p>
      </div>

      <div className="mt-12 grid max-w-3xl gap-14">
        {/* Section 1 */}
        <section aria-labelledby="brand-origin-heading">
          <h2
            id="brand-origin-heading"
            className="font-display text-2xl tracking-[-0.03em] md:text-3xl"
          >
            1. Về Thương Hiệu La.na Design — Hành Trình Tôn Vinh Nét Duyên Việt
          </h2>
          <div className="mt-4 space-y-4 text-base leading-7 text-black/75">
            <p>
              Thành lập từ <strong>năm 2022</strong>, <strong>La.na Design</strong> (hay còn được biết đến với tên gọi thân thuộc <strong>Lana Design</strong>) là thương hiệu thời trang nữ thiết kế cao cấp, được tạo dựng từ niềm đam mê gìn giữ và làm mới nét đẹp trang phục truyền thống của người phụ nữ Việt Nam trong nhịp sống đương đại.
            </p>
            <p>
              Ngay từ những ngày đầu khởi dựng, La.na Design đã định hình cho mình một lối đi riêng: <strong>Nữ tính, sang trọng, thanh lịch và mang đậm bản sắc Á Đông</strong>. Thương hiệu nhanh chóng khẳng định vị thế trong lòng phái đẹp qua những sáng tạo đặc sắc: từ những tà <strong>áo dài cách tân 4 tà</strong> thướt tha, bay bổng; những mẫu <strong>đầm tiệc</strong> quý phái, kiêu kỳ; cho đến các <strong>set đồ</strong> dạo phố, công sở chỉn chu mang tính ứng dụng cao.
            </p>
            <p>
              Với La.na, mỗi người phụ nữ là một đóa hoa mang vẻ đẹp và khí chất riêng biệt. Chúng tôi không chạy theo những xu hướng nhất thời, mà tập trung kiến tạo nên những thiết kế có giá trị bền vững cùng thời gian — nơi sự e ấp, dịu dàng hòa quyện cùng phong thái độc lập, rạng rỡ của người phụ nữ thế hệ mới.
            </p>
          </div>
        </section>

        {/* Section 2 */}
        <section aria-labelledby="craftsmanship-heading">
          <h2
            id="craftsmanship-heading"
            className="font-display text-2xl tracking-[-0.03em] md:text-3xl"
          >
            2. Dấu Ấn Thiết Kế &amp; Triết Lý Chế Tác
          </h2>
          <p className="mt-3 text-base leading-7 text-black/75">
            Để đáp ứng sự đa dạng trong phong cách và nhu cầu của quý cô ở từng sự kiện hay thời điểm trong năm, La.na Design xây dựng tiêu chuẩn khắt khe xuyên suốt trong mọi dòng sản phẩm:
          </p>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <div className="rounded-md border border-black/10 bg-[#FAFAFA] p-5">
              <h3 className="font-display text-lg font-medium tracking-[-0.01em]">
                Chất liệu cao cấp &amp; êm dịu
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Mỗi bộ sưu tập kết hợp linh hoạt nhiều dòng vải dệt tự nhiên, tơ lụa, voan tơ và gấm mềm mại, mang lại cảm giác thoáng nhẹ, êm dịu và giữ chuẩn phom dáng.
              </p>
            </div>
            <div className="rounded-md border border-black/10 bg-[#FAFAFA] p-5">
              <h3 className="font-display text-lg font-medium tracking-[-0.01em]">
                Phom dáng chuẩn vóc Việt
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Nghiên cứu tỷ lệ cơ thể phụ nữ Á Đông, từng đường cắt rập khéo léo tôn vinh đường cong tự nhiên và che khuyết điểm tinh tế mà vẫn thoải mái khi vận động.
              </p>
            </div>
            <div className="rounded-md border border-black/10 bg-[#FAFAFA] p-5">
              <h3 className="font-display text-lg font-medium tracking-[-0.01em]">
                Hoàn thiện tỉ mỉ từng chi tiết
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Đường kim mũi chỉ may giấu chỉ tinh xảo, phụ liệu cùng các chi tiết đính kết thủ công được chăm chút hài hòa, tạo nên dấu ấn sang trọng và độc bản.
              </p>
            </div>
          </div>
        </section>

        {/* Section 3 */}
        <section aria-labelledby="products-heading">
          <h2
            id="products-heading"
            className="font-display text-2xl tracking-[-0.03em] md:text-3xl"
          >
            3. Những Dòng Sản Phẩm Cốt Lõi
          </h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <div className="border-l-2 border-[#8B5E3C] pl-4">
              <h3 className="font-display text-lg font-medium">Áo Dài Cách Tân (Dấu Ấn 4 Tà &amp; Lễ Hội)</h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Dòng sản phẩm biểu tượng với phom 4 tà thướt tha, kết hợp giữa nét cổ truyền và phong cách hiện đại. Sự lựa chọn hoàn hảo cho ngày Tết, lễ dạm ngõ, ăn hỏi và cưới hỏi.
              </p>
            </div>
            <div className="border-l-2 border-[#8B5E3C] pl-4">
              <h3 className="font-display text-lg font-medium">Đầm Tiệc Quý Phái</h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Các mẫu đầm dáng xòe, suông hoặc chiết eo nhẹ tôn vinh thần thái đài các, kiêu sa của quý cô trong những buổi tiệc mừng, dạ yến và sự kiện quan trọng.
              </p>
            </div>
            <div className="border-l-2 border-[#8B5E3C] pl-4">
              <h3 className="font-display text-lg font-medium">Set Đồ Thanh Lịch</h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Phối hợp ăn ý giữa áo kiểu cùng chân váy hoặc quần suông thời thượng. Thiết kế mang tính ứng dụng cao, giúp nàng luôn tự tin và chỉn chu suốt ngày dài.
              </p>
            </div>
            <div className="border-l-2 border-[#8B5E3C] pl-4">
              <h3 className="font-display text-lg font-medium">Các Bộ Sưu Tập Nghệ Thuật</h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Ra mắt theo mùa với các câu chuyện thi vị như <em>Diệp Họa Thư</em>, <em>Xuân Hoài Kí</em>, <em>Tịnh Sắc</em>, <em>Lạc Nguyệt</em>, <em>Liên Sắc</em>, <em>Lập Thu</em>...
              </p>
            </div>
          </div>
        </section>

        {/* Section 4 */}
        <section aria-labelledby="experience-heading">
          <h2
            id="experience-heading"
            className="font-display text-2xl tracking-[-0.03em] md:text-3xl"
          >
            4. Nâng Tầm Trải Nghiệm Khách Hàng
          </h2>
          <ul className="mt-4 space-y-4 text-base leading-7 text-black/75">
            <li className="flex items-start gap-3">
              <span className="font-semibold text-[#8B5E3C]">•</span>
              <div>
                <strong>Tiên phong công nghệ Thử Đồ Ảo AI (Virtual Try-On):</strong> Trực quan hóa hình ảnh ướm thử trang phục ngay trên trang sản phẩm của website, giúp quý cô tự tin lựa chọn kiểu dáng phù hợp trước khi đặt hàng.
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-semibold text-[#8B5E3C]">•</span>
              <div>
                <strong>Tư vấn tận tâm 1:1:</strong> Đội ngũ tư vấn viên am hiểu sâu sắc về phom dáng và 3 bảng size chuyên biệt (Form rộng, Form vừa, Form nhỏ) luôn sẵn sàng hỗ trợ từ 08:00 đến 22:00 mỗi ngày.
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-semibold text-[#8B5E3C]">•</span>
              <div>
                <strong>Chính sách đổi hàng trong 15 ngày:</strong> Cam kết hỗ trợ đổi size, đổi mẫu linh hoạt và giao hàng tận nơi trên toàn quốc, đảm bảo sự an tâm tuyệt đối khi mua sắm online.
              </div>
            </li>
          </ul>
        </section>

        {/* Section 5 - Legal & Entity Facts */}
        <section aria-labelledby="legal-heading" className="border-t border-black/10 pt-10">
          <h2 id="legal-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            Thông tin pháp lý
          </h2>
          <p className="mt-2 text-sm text-black/60">
            Thông tin định danh doanh nghiệp minh bạch và địa chỉ tiếp nhận hỗ trợ chính thức.
          </p>
          <dl className="mt-6 grid max-w-2xl gap-6 text-base leading-7 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Thương hiệu</dt>
              <dd className="mt-2 text-black/80 font-medium">La.na Design (Lana Design)</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Đơn vị chủ quản</dt>
              <dd className="mt-2 text-black/80 font-medium">{data.legalEntityName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Mã số thuế</dt>
              <dd className="mt-2 text-black/80 font-medium">
                {data.taxCode} — ngày cấp: {data.taxIdIssueDate}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Năm thành lập</dt>
              <dd className="mt-2 text-black/80 font-medium">2022</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">
                Địa chỉ đăng ký kinh doanh
              </dt>
              <dd className="mt-2 text-black/80 font-medium">{data.registeredAddress}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">
                Địa chỉ kinh doanh &amp; nhận hàng đổi trả
              </dt>
              <dd className="mt-2 text-black/80 font-medium">{data.businessAddress}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Hotline / Zalo</dt>
              <dd className="mt-2 text-black/80 font-medium">
                <a href="tel:+84923159666" className="hover:underline">0923 159 666</a>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Email hỗ trợ &amp; CSKH</dt>
              <dd className="mt-2 text-black/80 font-medium">
                <a href="mailto:la.nadesignsince2022@gmail.com" className="hover:underline">la.nadesignsince2022@gmail.com</a>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.13em] text-black/50">Email công ty</dt>
              <dd className="mt-2 text-black/80 font-medium">{data.legalEmail}</dd>
            </div>
          </dl>
        </section>

        {/* Section 6 - FAQ */}
        <section aria-labelledby="faq-heading" className="border-t border-black/10 pt-10">
          <h2 id="faq-heading" className="font-display text-2xl tracking-[-0.02em] md:text-3xl">
            6. Câu Hỏi Thường Gặp (FAQ)
          </h2>
          <div className="mt-6 space-y-6">
            <div className="rounded-lg border border-black/10 p-5">
              <h3 className="font-display text-lg font-medium">
                La.na Design thành lập năm nào và chuyên về dòng sản phẩm gì?
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                La.na Design thành lập từ năm 2022, là thương hiệu thời trang nữ thiết kế cao cấp chuyên về các dòng áo dài cách tân 4 tà, đầm dự tiệc và set đồ thanh lịch dành cho phái đẹp.
              </p>
            </div>
            <div className="rounded-lg border border-black/10 p-5">
              <h3 className="font-display text-lg font-medium">
                Khách hàng có thể đến thử đồ trực tiếp ở đâu?
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Quý khách có thể ghé thăm và trải nghiệm trực tiếp không gian thời trang tại Showroom La.na Design: 212 Nguyễn Trãi, Hà Nội (mở cửa từ 08:00 đến 22:00 hàng ngày).
              </p>
            </div>
            <div className="rounded-lg border border-black/10 p-5">
              <h3 className="font-display text-lg font-medium">
                Tôi mua hàng online từ xa thì làm sao để chọn được size vừa vặn?
              </h3>
              <p className="mt-2 text-sm leading-6 text-black/70">
                Quý khách có thể trải nghiệm tính năng Thử đồ ảo AI ngay trên website, tham khảo bảng số đo chi tiết (ngực, eo, mông) hoặc nhắn tin trực tiếp qua hotline/Zalo 0923 159 666 để được chuyên viên tư vấn hỗ trợ chọn size chuẩn xác. La.na cũng áp dụng chính sách đổi size trong 15 ngày để nàng hoàn toàn yên tâm.
              </p>
            </div>
          </div>
        </section>
      </div>

      <p className="mt-14 max-w-2xl border-t border-black/10 pt-8 text-sm leading-6 text-black/65">
        Cần hỗ trợ?{" "}
        <Link
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          href="/contact"
        >
          Liên hệ {BRAND.identity.name}
        </Link>
        .
      </p>
    </PageShell>
  );
}

const route = createStorefrontRoute<AboutRouteProps, AboutViewModel>({
  load: loadAboutRoute,
  render,
  // A direct call to the canonical builder: the route contract accepts no other shape here.
  metadata: (props) => buildAboutMetadata(props),
});

export const generateMetadata = route.generateMetadata;
export default route.Page;
