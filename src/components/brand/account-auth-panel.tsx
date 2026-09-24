"use client";

import { ACCOUNT_AUTH_COPY } from "@/components/headless/account-auth-model";
import { useAccountAuth } from "@/components/headless/use-account-auth";

/**
 * Markup only. Every brand throws this file away and writes its own.
 *
 * No credential is validated here, no session is interpreted here and no message is chosen here:
 * all three come from `useAccountAuth`, which is where they must stay.
 */

// The storefront's own vocabulary: brand ink rather than pure black, the eyebrow's small caps for
// field labels, and the same filled / outlined capsule pair the listing and PDP buttons use.
const labelClassName = "text-xs uppercase tracking-[0.14em] text-[#70584B]";

const inputClassName =
  "account-auth-input w-full border-b border-[#3B2219]/30 bg-transparent px-0 py-3 text-base text-[#2A1810] outline-none transition-colors placeholder:text-[#3B2219]/35 focus-visible:border-[#2A1810] focus-visible:outline-2 focus-visible:outline-offset-4";

const buttonBaseClassName =
  "font-display inline-flex min-h-11 items-center justify-center rounded-full border border-[#3B2219] px-7 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-wait disabled:opacity-50";

const primaryButtonClassName = `${buttonBaseClassName} bg-[#3B2219] text-[#FAF7F2] hover:border-[#2A1810] hover:bg-[#2A1810]`;

const secondaryButtonClassName = `${buttonBaseClassName} text-[#3B2219] hover:bg-[#3B2219] hover:text-[#FAF7F2]`;

const formHeadingClassName = "mt-2 font-display text-2xl font-normal text-[#2A1810]";

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
      <div className="pt-8" aria-live="polite">
        <p className="text-sm text-[#3B2219]/65">{ACCOUNT_AUTH_COPY.checkingSession}</p>
      </div>
    );
  }

  if (view.mode === "signed-in" && session) {
    return (
      <section className="pt-8" aria-labelledby="account-session-title">
        <p className="eyebrow text-[#70584B]">Đã đăng nhập</p>
        <h2 id="account-session-title" className={formHeadingClassName}>
          Xin chào, {session.user.name}
        </h2>
        <p className="mt-2 text-sm text-[#3B2219]/65">{session.user.email}</p>
        <p className="mt-6 max-w-xl text-sm leading-6 text-[#3B2219]/75">
          Lịch sử đơn hàng và địa chỉ đã lưu sẽ xuất hiện ở đây khi các module tương ứng được bật.
        </p>
        <button
          className={`${secondaryButtonClassName} mt-8`}
          type="button"
          onClick={handleSignOut}
          disabled={view.signOutDisabled}
        >
          {view.signOutLabel}
        </button>
        {feedbackParagraph("mt-4 text-sm text-[#2A1810]")}
      </section>
    );
  }

  return (
    // The page header above already says what an account is for and that it is optional, so the
    // panel opens straight onto the two forms rather than restating it under a second headline.
    <section className="pt-8" aria-label="Đăng nhập hoặc tạo tài khoản">
      <div className="grid gap-12 md:grid-cols-2 lg:gap-24">
        <form
          className="space-y-6"
          onSubmit={handleSignIn}
          aria-busy={view.signInBusy}
          aria-labelledby="sign-in-title"
        >
          <div>
            <p className="eyebrow text-[#70584B]">Đã có tài khoản</p>
            <h2 id="sign-in-title" className={formHeadingClassName}>Đăng nhập</h2>
          </div>

          <div>
            <label className={labelClassName} htmlFor="sign-in-email">
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
            <label className={labelClassName} htmlFor="sign-in-password">
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

          <button className={primaryButtonClassName} type="submit" disabled={view.formsDisabled}>
            {view.signInLabel}
          </button>
        </form>

        <form
          className="space-y-6 border-t border-[#3B2219]/15 pt-10 md:border-l md:border-t-0 md:pl-12 md:pt-0 lg:pl-24"
          onSubmit={handleSignUp}
          aria-busy={view.signUpBusy}
          aria-labelledby="sign-up-title"
        >
          <div>
            <p className="eyebrow text-[#70584B]">Khách hàng mới</p>
            <h2 id="sign-up-title" className={formHeadingClassName}>Tạo tài khoản</h2>
          </div>

          <div>
            <label className={labelClassName} htmlFor="sign-up-name">
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
            <label className={labelClassName} htmlFor="sign-up-email">
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
            <label className={labelClassName} htmlFor="sign-up-password">
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
            <p className="mt-2 text-xs leading-5 text-[#3B2219]/65" id="sign-up-password-help">
              Từ 8 đến 128 ký tự.
            </p>
          </div>

          <button className={secondaryButtonClassName} type="submit" disabled={view.formsDisabled}>
            {view.signUpLabel}
          </button>
        </form>
      </div>

      {feedbackParagraph("mt-8 text-sm text-[#2A1810]")}
    </section>
  );
}
