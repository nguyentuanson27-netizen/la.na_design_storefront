"use client";

import { ACCOUNT_AUTH_COPY } from "@/components/headless/account-auth-model";
import { useAccountAuth } from "@/components/headless/use-account-auth";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * No credential is validated here, no session is interpreted here and no message is chosen here:
 * all three come from `useAccountAuth`, which is where they must stay.
 */

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

const buttonClassName =
  "inline-flex min-h-11 items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-wait disabled:opacity-50";

export function BrandAccountAuthPanel() {
  const { view, session, feedback, handleSignIn, handleSignUp, handleSignOut } = useAccountAuth();

  const feedbackParagraph = (className: string) =>
    feedback ? (
      <p className={className} role={feedback.tone === "error" ? "alert" : "status"}>
        {feedback.message}
      </p>
    ) : null;

  if (view.mode === "checking") {
    return (
      <div className="border-t border-black/20 pt-8" aria-live="polite">
        <p className="text-sm text-black/60">{ACCOUNT_AUTH_COPY.checkingSession}</p>
      </div>
    );
  }

  if (view.mode === "signed-in" && session) {
    return (
      <section className="border-t border-black/20 pt-8" aria-labelledby="account-session-title">
        <p className="eyebrow">Signed in</p>
        <h2 id="account-session-title" className="mt-4 font-display text-3xl md:text-5xl">
          Xin chào, {session.user.name}
        </h2>
        <p className="mt-3 text-sm text-black/60">{session.user.email}</p>
        <p className="mt-8 max-w-xl text-sm leading-6 text-black/70">
          Lịch sử đơn hàng và địa chỉ đã lưu sẽ xuất hiện ở đây khi các module tương ứng được bật.
        </p>
        <button
          className={`${buttonClassName} mt-8`}
          type="button"
          onClick={handleSignOut}
          disabled={view.signOutDisabled}
        >
          {view.signOutLabel}
        </button>
        {feedbackParagraph("mt-4 text-sm")}
      </section>
    );
  }

  return (
    <section className="border-t border-black/20 pt-8" aria-labelledby="account-access-title">
      <div className="mb-10 max-w-2xl">
        <p className="eyebrow">Optional account</p>
        <h2 id="account-access-title" className="mt-4 font-display text-3xl leading-tight md:text-5xl">
          Theo dõi đơn hàng thuận tiện hơn.
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-6 text-black/70">
          Tài khoản là tùy chọn. Bạn vẫn có thể mua hàng và thanh toán COD mà không cần đăng ký.
        </p>
      </div>

      <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
        <form className="space-y-6" onSubmit={handleSignIn} aria-busy={view.signInBusy}>
          <div>
            <p className="eyebrow">Returning customer</p>
            <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em]">Đăng nhập</h3>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.12em]" htmlFor="sign-in-email">
              Email
            </label>
            <input
              className={inputClassName}
              id="sign-in-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              disabled={view.formsDisabled}
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.12em]" htmlFor="sign-in-password">
              Mật khẩu
            </label>
            <input
              className={inputClassName}
              id="sign-in-password"
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={8}
              maxLength={128}
              required
              disabled={view.formsDisabled}
            />
          </div>

          <button className={buttonClassName} type="submit" disabled={view.formsDisabled}>
            {view.signInLabel}
          </button>
        </form>

        <form className="space-y-6" onSubmit={handleSignUp} aria-busy={view.signUpBusy}>
          <div>
            <p className="eyebrow">New customer</p>
            <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em]">Tạo tài khoản</h3>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.12em]" htmlFor="sign-up-name">
              Họ tên
            </label>
            <input
              className={inputClassName}
              id="sign-up-name"
              name="name"
              type="text"
              autoComplete="name"
              maxLength={120}
              required
              disabled={view.formsDisabled}
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.12em]" htmlFor="sign-up-email">
              Email
            </label>
            <input
              className={inputClassName}
              id="sign-up-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              disabled={view.formsDisabled}
            />
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.12em]" htmlFor="sign-up-password">
              Mật khẩu
            </label>
            <input
              className={inputClassName}
              id="sign-up-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              aria-describedby="sign-up-password-help"
              required
              disabled={view.formsDisabled}
            />
            <p className="mt-2 text-xs leading-5 text-black/60" id="sign-up-password-help">
              Từ 8 đến 128 ký tự.
            </p>
          </div>

          <button className={buttonClassName} type="submit" disabled={view.formsDisabled}>
            {view.signUpLabel}
          </button>
        </form>
      </div>

      {feedbackParagraph("mt-8 text-sm")}
    </section>
  );
}
