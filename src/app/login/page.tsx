import { BrandAccountAuthPanel } from "@/components/brand/account-auth-panel";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadLoginRoute, type LoginRouteProps, type LoginViewModel } from "@/routes/login";
import { buildLoginMetadata } from "@/routes/metadata/login";

/** The login page. Session state belongs to the panel, which reads it on the client. */

function render() {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Đăng nhập" }]} />
      <PageHeader
        eyebrow="Khách hàng"
        title="Đăng nhập"
        lead="Lưu thông tin cho lần mua sau và theo dõi đơn hàng tại một nơi. Tài khoản không bắt buộc: bạn vẫn có thể đặt hàng và thanh toán COD mà không cần đăng ký."
      />

      <BrandAccountAuthPanel />
    </PageShell>
  );
}

const route = createStorefrontRoute<LoginRouteProps, LoginViewModel>({
  load: loadLoginRoute,
  render,
});

export const metadata = buildLoginMetadata();
export default route.Page;
