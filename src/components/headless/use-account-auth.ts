"use client";

import { type FormEvent, useState } from "react";

import { submitEmailSignIn, submitEmailSignUp } from "@/auth/account-auth";
import { authClient } from "@/auth/client";

import {
  ACCOUNT_AUTH_COPY,
  readAccountFormValue,
  resolveAccountAuthView,
  resolveSignOutOutcome,
  type AccountAuthFeedback,
  type AccountPendingAction,
} from "./account-auth-model.ts";

/**
 * Account behaviour for a redrawn panel: the session, the three requests it can make, and what the
 * shopper is told about each.
 *
 * Credentials are validated by `@/auth/account-auth`, which owns that and keeps owning it. Which
 * view is showing and what is disabled come from `account-auth-model.ts`, which is pure and tested.
 * This file is the wiring that cannot be: the session hook, the auth client, and form state.
 */

export function useAccountAuth() {
  const { data: session, isPending: sessionPending, refetch } = authClient.useSession();
  const [pendingAction, setPendingAction] = useState<AccountPendingAction>(null);
  const [feedback, setFeedback] = useState<AccountAuthFeedback>(null);

  const view = resolveAccountAuthView({ sessionPending, session, pendingAction });

  async function submit(
    event: FormEvent<HTMLFormElement>,
    action: "sign-in" | "sign-up",
    run: (formData: FormData) => Promise<{ ok: boolean; message?: string }>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    setPendingAction(action);
    setFeedback(null);

    const result = await run(formData);

    if (!result.ok) {
      setFeedback({ tone: "error", message: result.message ?? "" });
      setPendingAction(null);
      return;
    }

    // Reset before the refetch: the credentials must not sit in the DOM while it is in flight.
    form.reset();
    await refetch();
    setFeedback({
      tone: "success",
      message: action === "sign-in" ? ACCOUNT_AUTH_COPY.signedIn : ACCOUNT_AUTH_COPY.signedUp,
    });
    setPendingAction(null);
  }

  function handleSignIn(event: FormEvent<HTMLFormElement>) {
    return submit(event, "sign-in", (formData) =>
      submitEmailSignIn((payload) => authClient.signIn.email(payload), {
        email: readAccountFormValue(formData, "email"),
        password: readAccountFormValue(formData, "password"),
      }),
    );
  }

  function handleSignUp(event: FormEvent<HTMLFormElement>) {
    return submit(event, "sign-up", (formData) =>
      submitEmailSignUp((payload) => authClient.signUp.email(payload), {
        name: readAccountFormValue(formData, "name"),
        email: readAccountFormValue(formData, "email"),
        password: readAccountFormValue(formData, "password"),
      }),
    );
  }

  async function handleSignOut() {
    setPendingAction("sign-out");
    setFeedback(null);

    try {
      const outcome = resolveSignOutOutcome(await authClient.signOut());
      if (!outcome.ok) {
        setFeedback(outcome.feedback);
        return;
      }
      await refetch();
    } catch {
      setFeedback(resolveSignOutOutcome("threw").feedback);
    } finally {
      setPendingAction(null);
    }
  }

  return { view, session, feedback, handleSignIn, handleSignUp, handleSignOut };
}
