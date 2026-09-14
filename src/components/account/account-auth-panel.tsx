"use client";

import { BrandAccountAuthPanel } from "@/components/brand/account-auth-panel";

/**
 * The panel's public surface, kept so today's account page renders unchanged.
 *
 * The session, the three requests and their messages now live in
 * `@/components/headless/use-account-auth` (with the decisions in the pure `account-auth-model`,
 * and credential validation still in `@/auth/account-auth`), and the markup in
 * `@/components/brand/account-auth-panel`. This is the seam between them and holds no logic.
 */

export function AccountAuthPanel() {
  return <BrandAccountAuthPanel />;
}
