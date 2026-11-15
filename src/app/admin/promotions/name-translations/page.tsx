import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin, requireCurrentAdminPage } from "@/auth/current-admin";
import {
  CAMPAIGN_NAME_LIMITS,
  parseCampaignNameInput,
} from "@/commerce/campaign-name-translation";
import { forgetCampaignNameMessages } from "@/commerce/campaign-name-translation-runtime";
import {
  createCampaignNameTranslationRepository,
  type CampaignNameKind,
} from "@/commerce/campaign-name-translation-repository";
import { prisma } from "@/db/prisma";

export const metadata: Metadata = { title: "Bản dịch tên chương trình khuyến mãi" };

const repository = createCampaignNameTranslationRepository(prisma);

const KIND_LABELS: Record<CampaignNameKind, string> = {
  PROMOTION: "Khuyến mãi",
  GIFT: "Quà tặng",
  SHIPPING: "Freeship",
  VOUCHER: "Voucher",
};

const inputClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-2 text-base outline-none transition-colors placeholder:text-black/35 focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";
const primaryButton =
  "min-h-11 bg-black px-6 text-xs font-semibold uppercase tracking-[0.14em] text-white focus-visible:outline-2 focus-visible:outline-offset-4";

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

type PageProps = {
  searchParams: Promise<{ saved?: string | string[]; error?: string | string[] }>;
};

/**
 * The English names of the shop's campaigns.
 *
 * A campaign is named by hand in Vietnamese, in the promotion, gift, freeship and voucher screens.
 * This lists every distinct name in use, once, with the kinds of campaign that carry it, and a field
 * for its English. The English shows on `/en` wherever the name is shown; an empty field keeps the
 * Vietnamese. Nothing is changed on the campaign itself: quotes, orders and the checkout's proofs
 * keep the Vietnamese name.
 */
export default async function AdminCampaignNameTranslationsPage({ searchParams }: PageProps) {
  await requireCurrentAdminPage();

  async function saveAll(formData: FormData) {
    "use server";

    await requireCurrentAdmin();
    const sources = formData.getAll("source");
    const texts = formData.getAll("text");
    if (sources.length !== texts.length) redirect("/admin/promotions/name-translations?error=FORM");

    const entries = [];
    for (let index = 0; index < sources.length; index += 1) {
      const parsed = parseCampaignNameInput(sources[index], texts[index]);
      if (!parsed.ok) redirect(`/admin/promotions/name-translations?error=${parsed.reason}`);
      entries.push(parsed.value);
    }

    // Only a name that a campaign still carries can be translated: the list is the authority, not
    // whatever the form posted.
    const known = new Set((await repository.listNames("en")).map((row) => row.source));
    for (const entry of entries) {
      if (known.has(entry.source)) await repository.save(entry, "en");
    }
    forgetCampaignNameMessages();
    revalidatePath("/admin/promotions/name-translations");
    redirect("/admin/promotions/name-translations?saved=1");
  }

  const [rows, query] = await Promise.all([repository.listNames("en"), searchParams]);
  const saved = queryValue(query.saved) === "1";
  const error = queryValue(query.error);
  const errorMessage =
    error === undefined
      ? null
      : error === "TEXT_TOO_LONG"
        ? `Tên tiếng Anh dài quá ${CAMPAIGN_NAME_LIMITS.text} ký tự.`
        : "Có tên chương trình không hợp lệ, hoặc biểu mẫu bị lỗi. Tải lại trang và thử lại.";

  return (
    <div className="mt-10 max-w-4xl">
      <Link className="text-xs font-semibold uppercase tracking-[0.13em] underline underline-offset-4" href="/admin/promotions">
        ← Khuyến mãi
      </Link>
      <h2 className="mt-4 font-display text-3xl tracking-[-0.02em]">Bản dịch tên chương trình</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-black/65">
        Tên tiếng Anh hiện trên trang <code>/en</code> ở mọi nơi tên chương trình xuất hiện. Để trống thì trang tiếng Anh dùng
        tên tiếng Việt. Báo giá, đơn hàng và voucher không đổi.
      </p>

      {saved ? (
        <p role="status" className="mt-6 border-l-[3px] border-black bg-black/[0.03] px-4 py-3 text-sm">
          Đã lưu bản dịch.
        </p>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="mt-6 border-l-[3px] border-[#b42318] px-4 py-3 text-sm text-[#b42318]">
          {errorMessage}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-black/65">Chưa có chương trình nào để dịch.</p>
      ) : (
        <form action={saveAll} className="mt-8">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Tên chương trình và bản dịch tiếng Anh</caption>
            <thead>
              <tr className="border-b border-black/20 text-xs uppercase tracking-[0.13em]">
                <th scope="col" className="py-3 pr-4 font-semibold">Tên tiếng Việt</th>
                <th scope="col" className="px-4 py-3 font-semibold">Loại</th>
                <th scope="col" className="py-3 pl-4 font-semibold">Tên tiếng Anh</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {rows.map((row, index) => (
                <tr key={row.source}>
                  <th scope="row" className="py-3 pr-4 align-top font-medium">
                    {row.source}
                    <input type="hidden" name="source" value={row.source} />
                  </th>
                  <td className="px-4 py-3 align-top text-black/65">
                    {row.kinds.map((kind) => KIND_LABELS[kind]).join(", ")}
                  </td>
                  <td className="py-3 pl-4 align-top">
                    <label className="sr-only" htmlFor={`name-en-${index}`}>
                      Tên tiếng Anh của {row.source}
                    </label>
                    <input
                      id={`name-en-${index}`}
                      name="text"
                      type="text"
                      lang="en"
                      defaultValue={row.text}
                      maxLength={CAMPAIGN_NAME_LIMITS.text}
                      className={inputClassName}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="submit" className={`${primaryButton} mt-8`}>
            Lưu bản dịch
          </button>
        </form>
      )}
    </div>
  );
}
