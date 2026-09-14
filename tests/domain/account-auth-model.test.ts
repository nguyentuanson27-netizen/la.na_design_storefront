import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_AUTH_COPY,
  readAccountFormValue,
  resolveAccountAuthView,
  resolveSignOutOutcome,
} from "../../src/components/headless/account-auth-model.ts";

/**
 * Characterization tests for the account panel's decisions, captured before they moved out of
 * `AccountAuthPanel`.
 *
 * The hook that wires these up cannot be unit-tested here: it calls `authClient.useSession()`,
 * which needs a renderer. So the decisions live in a pure module -- which of the three views is
 * showing, what is disabled while a request is in flight, and what a shopper is told -- and that
 * module is what these tests hold to the baseline.
 *
 * Credential validation is not among them: it already lives in `@/auth/account-auth` and stays
 * there.
 */

const session = { user: { name: "Lan", email: "lan@example.com" } };

/* -------------------------------------------------------------------- the view */

test("a session still being checked shows neither the forms nor the account", () => {
  const view = resolveAccountAuthView({ sessionPending: true, session: null, pendingAction: null });

  assert.equal(view.mode, "checking");
});

test("a checked-out visitor gets the sign-in and sign-up forms", () => {
  const view = resolveAccountAuthView({ sessionPending: false, session: null, pendingAction: null });

  assert.equal(view.mode, "signed-out");
  assert.equal(view.formsDisabled, false);
});

test("a signed-in shopper gets their own account instead", () => {
  const view = resolveAccountAuthView({ sessionPending: false, session, pendingAction: null });

  assert.equal(view.mode, "signed-in");
});

test("a session that arrives while still pending is not shown yet", () => {
  // The baseline checks `sessionPending` first, so a stale session cannot flash the account view
  // while a fresh check is in flight.
  const view = resolveAccountAuthView({ sessionPending: true, session, pendingAction: null });

  assert.equal(view.mode, "checking");
});

/* ------------------------------------------------------------------- in flight */

test("any request in flight disables both forms, not just the one submitted", () => {
  const signingIn = resolveAccountAuthView({
    sessionPending: false,
    session: null,
    pendingAction: "sign-in",
  });

  assert.equal(signingIn.formsDisabled, true);
  assert.equal(signingIn.signInBusy, true);
  assert.equal(signingIn.signUpBusy, false, "only the submitted form reports aria-busy");
  assert.equal(signingIn.signInLabel, "Đang đăng nhập…");
  assert.equal(signingIn.signUpLabel, "Tạo tài khoản", "the other button keeps its resting label");
});

test("each button announces its own work and nothing else's", () => {
  const signingUp = resolveAccountAuthView({
    sessionPending: false,
    session: null,
    pendingAction: "sign-up",
  });
  assert.equal(signingUp.signUpLabel, "Đang tạo…");
  assert.equal(signingUp.signInLabel, "Đăng nhập");

  const signingOut = resolveAccountAuthView({
    sessionPending: false,
    session,
    pendingAction: "sign-out",
  });
  assert.equal(signingOut.signOutLabel, "Đang đăng xuất…");
  assert.equal(signingOut.signOutDisabled, true);
});

test("the sign-out button is disabled by any pending action, not only its own", () => {
  const view = resolveAccountAuthView({
    sessionPending: false,
    session,
    pendingAction: "sign-in",
  });

  assert.equal(view.signOutDisabled, true);
  assert.equal(view.signOutLabel, "Đăng xuất");
});

/* -------------------------------------------------------------------- sign out */

test("a refused sign-out is reported without claiming the shopper is still signed in", () => {
  assert.deepEqual(resolveSignOutOutcome({ error: { message: "nope" } }), {
    ok: false,
    feedback: { tone: "error", message: ACCOUNT_AUTH_COPY.signOutFailed },
  });
});

test("a sign-out that threw reads the same as one the server refused", () => {
  assert.deepEqual(resolveSignOutOutcome("threw"), {
    ok: false,
    feedback: { tone: "error", message: ACCOUNT_AUTH_COPY.signOutFailed },
  });
});

test("a successful sign-out says nothing: the view itself is the answer", () => {
  assert.deepEqual(resolveSignOutOutcome({ error: null }), { ok: true, feedback: null });
  assert.deepEqual(resolveSignOutOutcome({}), { ok: true, feedback: null });
});

/* ------------------------------------------------------------------ form values */

test("a missing or non-text field reads as empty rather than as a file or null", () => {
  const formData = new FormData();
  formData.set("email", "lan@example.com");
  formData.set("avatar", new Blob(["x"]), "avatar.png");

  assert.equal(readAccountFormValue(formData, "email"), "lan@example.com");
  assert.equal(readAccountFormValue(formData, "password"), "");
  assert.equal(readAccountFormValue(formData, "avatar"), "");
});

/* ----------------------------------------------------------------------- copy */

test("the success copy is the baseline's, verbatim", () => {
  assert.equal(ACCOUNT_AUTH_COPY.signedIn, "Đăng nhập thành công.");
  assert.equal(ACCOUNT_AUTH_COPY.signedUp, "Tài khoản đã được tạo.");
  assert.equal(ACCOUNT_AUTH_COPY.signOutFailed, "Không thể đăng xuất lúc này. Vui lòng thử lại.");
  assert.equal(ACCOUNT_AUTH_COPY.checkingSession, "Đang kiểm tra phiên đăng nhập…");
});
