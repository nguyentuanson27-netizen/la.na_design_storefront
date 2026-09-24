import { BrandAccountAuthPanel } from "@/components/brand/account-auth-panel";
import { createStorefrontRoute } from "@/routes/factory";
import { loadLoginRoute, type LoginRouteProps, type LoginViewModel } from "@/routes/login";
import { buildLoginMetadata } from "@/routes/metadata/login";

/** The login page. Session state belongs to the panel, which reads it on the client. */

function render() {
  return (
    <div className="mx-auto min-h-[65vh] max-w-[1600px] px-6 py-16 md:py-24">
      <p className="eyebrow">Khách hàng / Đăng nhập</p>
      <h1 className="mt-4 text-[clamp(3.5rem,10vw,9rem)] font-semibold leading-[0.86] tracking-[-0.05em]">
        ĐĂNG NHẬP
      </h1>
      <div className="mt-12 grid gap-8 pb-12 md:grid-cols-2 md:pb-16">
        <p className="max-w-xl font-display text-2xl leading-snug md:text-3xl">
          Lưu thông tin cho lần mua sau và theo dõi lịch sử đơn hàng tại một nơi.
        </p>
        <p className="max-w-lg text-sm leading-6 text-black/70 md:justify-self-end">
          Đăng ký không bắt buộc. Guest checkout và thanh toán COD vẫn hoạt động độc lập với tài khoản.
        </p>
      </div>

      <BrandAccountAuthPanel />
    </div>
  );
}

const route = createStorefrontRoute<LoginRouteProps, LoginViewModel>({
  load: loadLoginRoute,
  render,
});

export const metadata = buildLoginMetadata();
export default route.Page;
