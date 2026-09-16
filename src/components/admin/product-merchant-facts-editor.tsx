import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentAdmin } from "@/auth/current-admin";
import { BRAND } from "@/brand";
import {
  MERCHANT_SHOP_APPAREL_DEFAULTS,
  USE_SHOP_DEFAULT,
  resolveEffectiveApparelFacts,
  type MerchantApparelField,
} from "@/commerce/merchant-apparel-facts";
import { createProductMerchantFactsAdminService } from "@/commerce/product-merchant-facts-admin";
import { createProductMerchantFactsRepository } from "@/commerce/product-merchant-facts-repository";
import { prisma } from "@/db/prisma";

const repository = createProductMerchantFactsRepository(prisma);
const adminService = createProductMerchantFactsAdminService({
  productExists: repository.productExists,
  saveOverrides: repository.saveOverrides,
});

const selectClassName =
  "w-full border-b border-black/30 bg-transparent px-0 py-3 text-base outline-none transition-colors focus-visible:border-black focus-visible:outline-2 focus-visible:outline-offset-4";

/**
 * Vietnamese labels for the reviewed Merchant values.
 *
 * Display text only. The values submitted and stored are the Merchant controlled values themselves,
 * so a label change can never become a data change.
 */
const VALUE_LABELS: Readonly<Record<string, string>> = {
  male: "Nam",
  female: "Nữ",
  unisex: "Unisex",
  newborn: "Sơ sinh",
  infant: "Nhũ nhi",
  toddler: "Tập đi",
  kids: "Trẻ em",
  adult: "Người lớn",
  new: "Hàng mới",
  refurbished: "Hàng tân trang",
  used: "Đã qua sử dụng",
};

type ApparelControl = Readonly<{
  field: MerchantApparelField;
  label: string;
  values: readonly string[];
}>;

const CONTROLS: readonly ApparelControl[] = [
  { field: "gender", label: "Giới tính", values: ["male", "female", "unisex"] },
  {
    field: "ageGroup",
    label: "Nhóm tuổi",
    values: ["newborn", "infant", "toddler", "kids", "adult"],
  },
  { field: "condition", label: "Tình trạng", values: ["new", "refurbished", "used"] },
];

type ProductMerchantFactsEditorProps = {
  productId: string;
  editorPath: string;
  saved: boolean;
  error: boolean;
};

export async function ProductMerchantFactsEditor({
  productId,
  editorPath,
  saved,
  error,
}: ProductMerchantFactsEditorProps) {
  const persisted = await repository.readOverrides(productId);
  // Resolved only to show the operator what Merchant would actually emit today. A malformed stored
  // value is reported here as unresolved rather than smoothed over, matching what the mapper does.
  const effective = resolveEffectiveApparelFacts(persisted);

  async function saveMerchantFacts(formData: FormData) {
    "use server";

    const adminSession = await requireCurrentAdmin();
    const result = await adminService.update(adminSession, {
      productId,
      gender: formData.get("gender"),
      ageGroup: formData.get("ageGroup"),
      condition: formData.get("condition"),
    });

    if (!result.ok) {
      if (result.reason === "PRODUCT_NOT_FOUND") redirect("/admin");
      redirect(`${editorPath}?merchantError=1`);
    }

    revalidatePath(editorPath);
    redirect(`${editorPath}?merchantSaved=1`);
  }

  return (
    <section
      aria-labelledby="product-merchant-facts-heading"
      className="mt-8 border border-black/20 p-6 md:p-8"
    >
      <p className="eyebrow">Google Merchant · sở hữu bởi {BRAND.identity.name}</p>
      <h2 id="product-merchant-facts-heading" className="mt-2 font-serif text-3xl tracking-[-0.03em]">
        Thuộc tính thời trang
      </h2>
      <p className="mt-4 max-w-3xl text-xs leading-5 text-black/55">
        Mặc định cửa hàng đã được duyệt là{" "}
        <strong>{VALUE_LABELS[MERCHANT_SHOP_APPAREL_DEFAULTS.gender]}</strong>,{" "}
        <strong>{VALUE_LABELS[MERCHANT_SHOP_APPAREL_DEFAULTS.ageGroup]}</strong>,{" "}
        <strong>{VALUE_LABELS[MERCHANT_SHOP_APPAREL_DEFAULTS.condition]}</strong>. Mỗi thuộc tính
        được đặt riêng. Chọn &ldquo;Dùng mặc định cửa hàng&rdquo; sẽ xóa giá trị riêng của sản phẩm và
        quay lại kế thừa, chứ không lưu một bản sao của mặc định. Đồng bộ Pancake không ghi đè các
        giá trị này. Giá trị không bao giờ được suy đoán từ tên, mô tả, danh mục hay kích cỡ.
      </p>

      {saved ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="status">
          Đã lưu thuộc tính Merchant của sản phẩm.
        </p>
      ) : null}
      {error ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          Giá trị không hợp lệ. Không có thay đổi nào được lưu.
        </p>
      ) : null}
      {!effective.ok ? (
        <p className="mt-5 border-l-2 border-black pl-4 text-sm font-semibold" role="alert">
          Dữ liệu thuộc tính đang lưu không hợp lệ nên sản phẩm này bị loại khỏi Merchant
          (APPAREL_FACT_UNRESOLVED). Hãy chọn lại giá trị hợp lệ.
        </p>
      ) : null}

      <form action={saveMerchantFacts} className="mt-6 grid gap-6 md:grid-cols-3">
        {CONTROLS.map((control) => {
          const selectId = `merchant-${control.field}`;
          const stored = persisted[control.field];
          const isInherited = stored === null;
          const defaultLabel = VALUE_LABELS[MERCHANT_SHOP_APPAREL_DEFAULTS[control.field]];

          return (
            <div className="block" key={control.field}>
              <label
                className="text-xs font-semibold uppercase tracking-[0.13em]"
                htmlFor={selectId}
              >
                {control.label}
              </label>
              <select
                className={selectClassName}
                defaultValue={stored ?? USE_SHOP_DEFAULT}
                id={selectId}
                name={control.field}
              >
                <option value={USE_SHOP_DEFAULT}>
                  Dùng mặc định cửa hàng: {defaultLabel}
                </option>
                {control.values.map((value) => (
                  <option key={value} value={value}>
                    {VALUE_LABELS[value]}
                  </option>
                ))}
              </select>
              <p className="mt-3 text-xs leading-5 text-black/55">
                {isInherited
                  ? `Đang kế thừa mặc định cửa hàng (${defaultLabel}).`
                  : `Giá trị riêng của sản phẩm: ${VALUE_LABELS[stored] ?? stored}.`}
              </p>
            </div>
          );
        })}

        <div className="md:col-span-3">
          <button
            className="inline-flex min-h-11 items-center justify-center border border-black px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4"
            type="submit"
          >
            Lưu thuộc tính Merchant
          </button>
        </div>
      </form>
    </section>
  );
}
