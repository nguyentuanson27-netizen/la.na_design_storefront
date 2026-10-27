import Link from "next/link";

/** TEST HARNESS ONLY: a second page to navigate to, prefetch and come back from. */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default function VoucherHoldHarnessOtherPage() {
  return (
    <main data-testid="other">
      <h1>Other</h1>
      <Link href="/voucher-hold-harness" data-testid="link-back">
        Back
      </Link>
    </main>
  );
}
