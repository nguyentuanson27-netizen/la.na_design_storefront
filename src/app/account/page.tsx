import { BrandAccountAuthPanel } from "@/components/brand/account-auth-panel";
import { PageBreadcrumbs, PageHeader, PageShell } from "@/components/brand/page-chrome";
import { createStorefrontRoute } from "@/routes/factory";
import { loadAccountRoute, type AccountRouteProps, type AccountViewModel } from "@/routes/account";
import { buildAccountMetadata } from "@/routes/metadata/account";

/** The account page. Session state belongs to the panel, which reads it on the client. */

// The view model is empty, so the render prop takes nothing: naming an argument it never reads
// would only invite someone to start reading one.
function render() {
  return (
    <PageShell>
      <PageBreadcrumbs items={[{ label: "Trang chủ", href: "/" }, { label: "Tài khoản" }]} />
      <PageHeader
        eyebrow="Khách hàng"
        title="Tài khoản"
        lead="Lưu thông tin cho lần mua sau và theo dõi đơn hàng tại một nơi. Tài khoản không bắt buộc: bạn vẫn có thể đặt hàng và thanh toán COD mà không cần đăng ký."
      />

      <BrandAccountAuthPanel />
    </PageShell>
  );
}

const route = createStorefrontRoute<AccountRouteProps, AccountViewModel>({
  load: loadAccountRoute,
  render,
});

export const metadata = buildAccountMetadata();
export default route.Page;
