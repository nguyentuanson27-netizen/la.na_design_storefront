/**
 * Every decision the account panel makes, as pure functions.
 *
 * These are separated from `use-account-auth.ts` because the hook calls `authClient.useSession()`,
 * which needs a renderer and so cannot be exercised here. What is left is what a brand redrawing
 * the panel must never have to decide again: which of the three views is showing, what is disabled
 * while a request is in flight, and what the shopper is told.
 *
 * Credential validation is deliberately absent. It lives in `@/auth/account-auth` and stays there;
 * duplicating it in a UI seam is how two answers to one question get shipped.
 */

export const ACCOUNT_AUTH_COPY = Object.freeze({
  checkingSession: "Đang kiểm tra phiên đăng nhập…",
  signedIn: "Đăng nhập thành công.",
  signedUp: "Tài khoản đã được tạo.",
  signOutFailed: "Không thể đăng xuất lúc này. Vui lòng thử lại.",
});

export type AccountPendingAction = "sign-in" | "sign-up" | "sign-out" | null;

export type AccountAuthFeedback = Readonly<{
  tone: "error" | "success";
  message: string;
}> | null;

export type AccountAuthViewInput = Readonly<{
  sessionPending: boolean;
  /** Only its presence is a decision here; the brand reads the user off its own session object. */
  session: unknown;
  pendingAction: AccountPendingAction;
}>;

export type AccountAuthView = Readonly<{
  /** `checking` is decided first, so a stale session cannot flash the account view mid-check. */
  mode: "checking" | "signed-in" | "signed-out";
  /** One request in flight disables both forms: they write the same session. */
  formsDisabled: boolean;
  signInBusy: boolean;
  signUpBusy: boolean;
  signInLabel: string;
  signUpLabel: string;
  signOutLabel: string;
  signOutDisabled: boolean;
}>;

export function resolveAccountAuthView({
  sessionPending,
  session,
  pendingAction,
}: AccountAuthViewInput): AccountAuthView {
  const busy = pendingAction !== null;

  return Object.freeze({
    mode: sessionPending ? ("checking" as const) : session ? ("signed-in" as const) : ("signed-out" as const),
    formsDisabled: busy,
    signInBusy: pendingAction === "sign-in",
    signUpBusy: pendingAction === "sign-up",
    signInLabel: pendingAction === "sign-in" ? "Đang đăng nhập…" : "Đăng nhập",
    signUpLabel: pendingAction === "sign-up" ? "Đang tạo…" : "Tạo tài khoản",
    signOutLabel: pendingAction === "sign-out" ? "Đang đăng xuất…" : "Đăng xuất",
    signOutDisabled: busy,
  });
}

/**
 * The outcome of one sign-out attempt.
 *
 * A refusal and a thrown call read the same to the shopper, because they mean the same thing: the
 * session may still be live, so nothing here claims it was ended. A success says nothing at all --
 * the panel switching back to the forms is the answer.
 */
export function resolveSignOutOutcome(
  result: "threw" | Readonly<{ error?: unknown }>,
): Readonly<{ ok: boolean; feedback: AccountAuthFeedback }> {
  if (result !== "threw" && !result.error) {
    return Object.freeze({ ok: true, feedback: null });
  }

  return Object.freeze({
    ok: false,
    feedback: Object.freeze({ tone: "error" as const, message: ACCOUNT_AUTH_COPY.signOutFailed }),
  });
}

/** A field that is absent, or is a file rather than text, reads as empty. */
export function readAccountFormValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
