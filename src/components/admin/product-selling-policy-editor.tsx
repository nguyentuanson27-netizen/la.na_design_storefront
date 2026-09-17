import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import { createSellingPolicyAdminService } from "@/commerce/capacity-admin";
import {
  SELLING_POLICY_MODE_INPUTS,
  type SellingPolicyModeInput,
} from "@/commerce/capacity-policy-input";
import { DEFAULT_NEGATIVE_STOCK_LIMIT, type SellingMode } from "@/commerce/capacity-policy";
import { createCapacityRepository } from "@/commerce/capacity-repository";
import { prisma } from "@/db/prisma";
import { readPancakeShopId } from "@/integrations/pancake/config";

const repository = createCapacityRepository(prisma);

/**
 * Display text only. The values submitted are the three allowlisted strings themselves, so a label
 * change can never become a data change — the same separation the Merchant facts editor keeps.
 */
const MODE_LABELS: Readonly<Record<SellingPolicyModeInput, string>> = {
  standard: "Tiêu chuẩn",
  oversell: "Cho phép bán âm",
  preorder: "Đặt trước",
};

const MODE_DESCRIPTIONS: Readonly<Record<SellingPolicyModeInput, string>> = {
  standard: "Hết hàng ở 0. Hạn mức âm bên dưới không có tác dụng ở chế độ này.",
  oversell: "Bán xuống dưới 0 tới đúng hạn mức. Không hiện nhãn nào cho khách.",
  preorder: "Như trên, nhưng khi hết hàng sẵn sẽ hiện “Đặt trước” cho khách.",
};

const STORED_TO_INPUT: Readonly<Record<SellingMode, SellingPolicyModeInput>> = {
  STANDARD: "standard",
  OVERSELL: "oversell",
  PREORDER: "preorder",
};

type ProductSellingPolicyEditorProps = {
  productId: string;
  editorPath: string;
  saved: boolean;
  error: string | undefined;
};

/**
 * Operator-facing reasons. Every refusal the I2 boundary can return has one, because an operator
 * who is told only "không hợp lệ" has to guess which of three fields the boundary objected to.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "selling-policy-composite-restricted":
    "Sản phẩm này là set (có sản phẩm thành phần). Set chỉ được đặt Tiêu chuẩn cho tới khi có kiểm soát tồn kho theo thành phần. Chưa có thay đổi nào được lưu.",
  "selling-policy-invalid-limit":
    "Hạn mức phải là số nguyên không dương (0 hoặc âm). Chưa có thay đổi nào được lưu.",
  "selling-policy-unknown-mode": "Chế độ bán không hợp lệ. Chưa có thay đổi nào được lưu.",
  "selling-policy-invalid-product":
    "Không tìm thấy sản phẩm này trong cửa hàng. Chưa có thay đổi nào được lưu.",
  "selling-policy-shape": "Biểu mẫu không hợp lệ. Chưa có thay đổi nào được lưu.",
};

export async function ProductSellingPolicyEditor({
  productId,
  editorPath,
  saved,
  error,
}: ProductSellingPolicyEditorProps) {
  // Through the resolver, so this surface shows the same missing-row answer every consumer gets
  // (ADR 0014 §5.1) rather than inventing a second opinion about what "not configured" means.
  const policy = await repository.readSellingPolicy(productId);
  const selectedMode = STORED_TO_INPUT[policy.sellingMode];

  async function saveSellingPolicy(formData: FormData) {
    "use server";

    // Built inside the action, not captured from the component scope. A `"use server"` closure
    // serializes the variables it binds, and a function is not serializable — capturing one here
    // fails at request time with "Functions cannot be passed directly to Client Components", which
    // the build does not catch and the admin a11y runtime does.
    const adminService = createSellingPolicyAdminService({
      shopId: readPancakeShopId(),
      repository,
    });
    const adminSession = await requireCurrentAdmin();
    const rawLimit = formData.get("negativeStockLimit");
    const result = await adminService.saveSellingPolicy(adminSession, {
      productId,
      sellingMode: formData.get("sellingMode"),
      // An emptied field means "use the approved default", which the parser answers. Anything else
      // is handed over as a number so a non-numeric entry is refused rather than coerced to 0 —
      // 0 is a legitimate limit ("bán âm bật, không cho phép âm"), so it must not be what a typo
      // silently becomes.
      negativeStockLimit:
        typeof rawLimit === "string" && rawLimit.trim().length > 0 ? Number(rawLimit) : null,
    });

    if (!result.ok) redirect(`${editorPath}?policyError=${result.reason}`);

    revalidatePath(editorPath);
    redirect(`${editorPath}?policySaved=1`);
  }

  async function clearSellingPolicy() {
    "use server";

    const adminService = createSellingPolicyAdminService({
      shopId: readPancakeShopId(),
      repository,
    });
    const adminSession = await requireCurrentAdmin();
    const result = await adminService.clearSellingPolicy(adminSession, { productId });

    if (!result.ok) redirect(`${editorPath}?policyError=${result.reason}`);

    revalidatePath(editorPath);
    redirect(`${editorPath}?policySaved=1`);
  }

  return (
    <section
      aria-labelledby="product-selling-policy-heading"
      className="mt-8 border border-black/20 p-6 md:p-8"
    >
      <p className="eyebrow">Tồn kho · chế độ bán</p>
      <h2
        id="product-selling-policy-heading"
        className="mt-2 font-serif text-3xl tracking-[-0.03em]"
      >
        Chế độ bán và hạn mức âm
      </h2>
      <p className="mt-4 max-w-3xl text-xs leading-5 text-black/55">
        Sản phẩm chưa cấu hình sẽ chạy theo mặc định đã duyệt: Tiêu chuẩn, hạn mức{" "}
        <strong>{DEFAULT_NEGATIVE_STOCK_LIMIT}</strong>. Đồng bộ Pancake không ghi đè cấu hình này.
        Tắt bán âm <strong>không</strong> đưa tồn kho âm về 0 — giá trị âm được giữ nguyên và luật
        tiêu chuẩn sẽ chặn bán mới cho tới khi tồn kho dương trở lại.
      </p>

      {saved ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="status">
          Đã lưu chế độ bán của sản phẩm.
        </p>
      ) : null}
      {error ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          {ERROR_MESSAGES[error] ?? ERROR_MESSAGES["selling-policy-shape"]}
        </p>
      ) : null}

      <p className="mt-5 text-xs leading-5 text-black/55">
        {policy.isDefault
          ? "Trạng thái: chưa cấu hình (đang dùng mặc định)."
          : `Trạng thái: đã cấu hình — ${MODE_LABELS[selectedMode]}, hạn mức ${policy.negativeStockLimit}.`}
      </p>

      <form action={saveSellingPolicy} className="mt-6 grid gap-6">
        {/* A fieldset rather than three loose radios: the three modes are one mutually exclusive
            choice, and that is what a screen reader needs announced before the options. */}
        <fieldset className="border-0 p-0">
          <legend className="text-xs font-semibold uppercase tracking-[0.13em]">Chế độ bán</legend>
          <div className="mt-4 grid gap-4">
            {SELLING_POLICY_MODE_INPUTS.map((mode) => {
              const inputId = `selling-mode-${mode}`;
              return (
                <div className="flex gap-3" key={mode}>
                  <input
                    className="mt-1 size-4 shrink-0 accent-black focus-visible:outline-2 focus-visible:outline-offset-4"
                    defaultChecked={mode === selectedMode}
                    id={inputId}
                    name="sellingMode"
                    type="radio"
                    value={mode}
                  />
                  <label className="text-sm leading-5" htmlFor={inputId}>
                    <span className="font-semibold">{MODE_LABELS[mode]}</span>
                    <span className="mt-1 block text-xs leading-5 text-black/55">
                      {MODE_DESCRIPTIONS[mode]}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="max-w-xs">
          <label
            className="text-xs font-semibold uppercase tracking-[0.13em]"
            htmlFor="negative-stock-limit"
          >
            Hạn mức âm
          </label>
          <input
            className="w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
            defaultValue={policy.negativeStockLimit}
            id="negative-stock-limit"
            inputMode="numeric"
            max={0}
            name="negativeStockLimit"
            step={1}
            type="number"
          />
          <p className="mt-3 text-xs leading-5 text-black/55">
            Số nguyên, 0 hoặc âm. Bỏ trống để dùng mặc định {DEFAULT_NEGATIVE_STOCK_LIMIT}. Giá trị
            này được lưu cho cả chế độ Tiêu chuẩn, nên khi đổi qua lại sẽ không mất hạn mức đã đặt.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-11 items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
            type="submit"
          >
            Lưu chế độ bán
          </button>
        </div>
      </form>

      {/* Its own form: clearing is not a variant of saving. §5.1 makes "chưa cấu hình" a distinct
          state from "cấu hình đúng bằng mặc định", and an operator needs a way back to it. */}
      <form action={clearSellingPolicy} className="mt-4">
        <button
          className="inline-flex min-h-11 items-center justify-center border border-black/30 px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:border-black focus-visible:outline-2 focus-visible:outline-offset-4"
          type="submit"
        >
          Xóa cấu hình, quay lại mặc định
        </button>
      </form>
    </section>
  );
}
