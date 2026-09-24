"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";

import {
  loadCheckoutCommunesAction,
  loadCheckoutDistrictsAction,
  loadCheckoutProvincesAction,
} from "@/commerce/checkout-geo-actions";
import { BRAND } from "@/brand";
import { checkoutSubmitFeedback } from "@/commerce/checkout-submit-feedback";
import { submitGuestCheckoutAction } from "@/commerce/guest-checkout-actions";
import type {
  PancakeCommune,
  PancakeDistrict,
  PancakeProvince,
} from "@/integrations/pancake/geo";

type GeoError = Readonly<{
  level: "provinces" | "districts" | "communes";
  message: string;
}>;

const fieldClassName =
  "mt-2 w-full border border-black/25 bg-transparent px-4 py-3 text-base outline-none transition focus:border-black focus:ring-2 focus:ring-black/10 disabled:cursor-not-allowed disabled:bg-black/[0.04] disabled:text-black/45";

const geoFailures = {
  provinces: {
    level: "provinces",
    message: "Chưa tải được danh sách tỉnh/thành. Vui lòng thử lại.",
  },
  districts: {
    level: "districts",
    message: "Chưa tải được danh sách quận/huyện. Vui lòng thử lại.",
  },
  communes: {
    level: "communes",
    message: "Chưa tải được danh sách phường/xã. Vui lòng thử lại.",
  },
} as const satisfies Record<GeoError["level"], GeoError>;

export function GuestCheckoutForm({
  quoteProof,
  summaryLabel,
  summarySlot,
  totalsSlot,
  preorderSlot,
}: Readonly<{
  quoteProof: string;
  summaryLabel?: string;
  summarySlot?: ReactNode;
  totalsSlot?: ReactNode;
  preorderSlot?: ReactNode;
}>) {
  const [submitState, submitAction, isSubmitting] = useActionState(
    submitGuestCheckoutAction,
    null,
  );
  const router = useRouter();
  const [isRefreshingQuote, startQuoteRefresh] = useTransition();
  const [provinces, setProvinces] = useState<PancakeProvince[]>([]);
  const [districts, setDistricts] = useState<PancakeDistrict[]>([]);
  const [communes, setCommunes] = useState<PancakeCommune[]>([]);
  const [provinceRef, setProvinceRef] = useState("");
  const [districtRef, setDistrictRef] = useState("");
  const [communeRef, setCommuneRef] = useState("");
  const [provinceLoading, setProvinceLoading] = useState(true);
  const [districtLoading, setDistrictLoading] = useState(false);
  const [communeLoading, setCommuneLoading] = useState(false);
  const [geoError, setGeoError] = useState<GeoError | null>(null);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const summaryContentId = useId();
  const provinceRequest = useRef(0);
  const districtRequest = useRef(0);
  const communeRequest = useRef(0);

  const requestProvinces = useCallback(async () => {
    const requestId = ++provinceRequest.current;
    ++districtRequest.current;
    ++communeRequest.current;
    setProvinceLoading(true);
    setDistrictLoading(false);
    setCommuneLoading(false);
    setGeoError(null);
    setProvinceRef("");
    setDistrictRef("");
    setCommuneRef("");
    setDistricts([]);
    setCommunes([]);

    try {
      const result = await loadCheckoutProvincesAction();
      if (requestId !== provinceRequest.current) return;

      if (!result.ok) {
        setProvinces([]);
        setGeoError(geoFailures.provinces);
        return;
      }
      setProvinces(result.options);
    } catch {
      if (requestId !== provinceRequest.current) return;
      setProvinces([]);
      setGeoError(geoFailures.provinces);
    } finally {
      if (requestId === provinceRequest.current) {
        setProvinceLoading(false);
      }
    }
  }, []);

  const requestDistricts = useCallback(async (selectedProvince: string) => {
    const requestId = ++districtRequest.current;
    setDistrictLoading(true);
    setGeoError(null);

    try {
      const result = await loadCheckoutDistrictsAction(selectedProvince);
      if (requestId !== districtRequest.current) return;

      if (!result.ok) {
        setDistricts([]);
        setGeoError(geoFailures.districts);
        return;
      }
      setDistricts(result.options);
    } catch {
      if (requestId !== districtRequest.current) return;
      setDistricts([]);
      setGeoError(geoFailures.districts);
    } finally {
      if (requestId === districtRequest.current) {
        setDistrictLoading(false);
      }
    }
  }, []);

  const requestCommunes = useCallback(
    async (selectedProvince: string, selectedDistrict: string) => {
      const requestId = ++communeRequest.current;
      setCommuneLoading(true);
      setGeoError(null);

      try {
        const result = await loadCheckoutCommunesAction(
          selectedProvince,
          selectedDistrict,
        );
        if (requestId !== communeRequest.current) return;

        if (!result.ok) {
          setCommunes([]);
          setGeoError(geoFailures.communes);
          return;
        }
        setCommunes(result.options);
      } catch {
        if (requestId !== communeRequest.current) return;
        setCommunes([]);
        setGeoError(geoFailures.communes);
      } finally {
        if (requestId === communeRequest.current) {
          setCommuneLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const requestId = ++provinceRequest.current;
    let active = true;

    void (async () => {
      try {
        const result = await loadCheckoutProvincesAction();
        if (!active || requestId !== provinceRequest.current) return;

        if (!result.ok) {
          setProvinces([]);
          setGeoError(geoFailures.provinces);
          return;
        }
        setProvinces(result.options);
      } catch {
        if (!active || requestId !== provinceRequest.current) return;
        setProvinces([]);
        setGeoError(geoFailures.provinces);
      } finally {
        if (active && requestId === provinceRequest.current) {
          setProvinceLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      if (requestId === provinceRequest.current) {
        ++provinceRequest.current;
      }
    };
  }, []);

  // After a refusal the order summary beside this form still holds the price the page was rendered
  // with, so the screen is showing one total while the warning quotes another. Refreshing re-renders
  // it from the server without discarding what the buyer has typed.
  //
  // The refresh is not cosmetic, which is why it runs in a transition whose pending state disables
  // submitting. The proof this form carries is always the one the *current* server render issued
  // alongside the quote on screen, and it binds line identities, quantities and per-line prices —
  // not just the total in the warning. Letting a re-submit through before the refresh installs the
  // matching render would confirm a basket the buyer has not seen yet, which is exactly the
  // acknowledgement this whole mechanism exists to obtain. If the refresh stalls or fails, submit
  // stays disabled and nothing is confirmed.
  //
  // Keyed on the response itself rather than on `priceChanged`: a second consecutive price change
  // leaves that boolean true, and an effect keyed on it would never fire again.
  useEffect(() => {
    if (submitState && !submitState.ok && submitState.status === "PRICE_CHANGED") {
      startQuoteRefresh(() => router.refresh());
    }
  }, [submitState, router]);

  const feedback = submitState ? checkoutSubmitFeedback(submitState) : null;
  const lockSubmission = feedback ? !feedback.mayRetry : false;
  const geoBusy = provinceLoading || districtLoading || communeLoading;
  const submitDisabled =
    isSubmitting ||
    geoBusy ||
    Boolean(geoError) ||
    !provinceRef ||
    !districtRef ||
    !communeRef ||
    isRefreshingQuote ||
    lockSubmission;

  function handleProvinceChange(value: string) {
    setProvinceRef(value);
    setDistrictRef("");
    setCommuneRef("");
    setDistricts([]);
    setCommunes([]);
    ++communeRequest.current;
    setCommuneLoading(false);
    setGeoError(null);

    if (!value) {
      ++districtRequest.current;
      setDistrictLoading(false);
      return;
    }
    void requestDistricts(value);
  }

  function handleDistrictChange(value: string) {
    setDistrictRef(value);
    setCommuneRef("");
    setCommunes([]);
    setGeoError(null);

    if (!value) {
      ++communeRequest.current;
      setCommuneLoading(false);
      return;
    }
    void requestCommunes(provinceRef, value);
  }

  function retryGeoRead() {
    if (!geoError) return;
    if (geoError.level === "provinces") {
      void requestProvinces();
      return;
    }
    if (geoError.level === "districts" && provinceRef) {
      void requestDistricts(provinceRef);
      return;
    }
    if (geoError.level === "communes" && provinceRef && districtRef) {
      void requestCommunes(provinceRef, districtRef);
    }
  }

  const feedbackTone =
    feedback?.tone === "success"
      ? "border-black bg-black text-white"
      : feedback?.tone === "warning"
        ? "border-black/35 bg-black/[0.04] text-black"
        : "border-black bg-transparent text-black";

  return (
    <form action={submitAction} className="space-y-8">
      {/* Opaque, server-authenticated, and always the token issued by the render currently on
          screen. Editing it cannot change what the buyer is charged: the server recomputes the price
          itself and only asks this token whether that price is the one it already showed. A tampered
          or swapped value simply fails closed into re-confirmation. */}
      <input name="quoteProof" type="hidden" value={quoteProof} />

      {/* Below `lg` only: at `lg+` the page's sticky aside is the order summary, already expanded,
          so a second collapsible copy would be two summaries of one order. */}
      {summarySlot && summaryLabel ? (
        <section className="checkout-order-summary lg:hidden">
          <button
            type="button"
            aria-controls={summaryContentId}
            aria-expanded={isSummaryOpen}
            onClick={() => setIsSummaryOpen((open) => !open)}
            className="flex min-h-11 w-full items-center justify-between gap-4 text-left text-sm font-semibold"
          >
            <span>{summaryLabel}</span>
            <span aria-hidden="true">{isSummaryOpen ? "−" : "＋"}</span>
          </button>
          <div id={summaryContentId} className={`${isSummaryOpen ? "block" : "hidden"} pt-5`}>
            {summarySlot}
          </div>
        </section>
      ) : null}

      <div className="checkout-receiving-fields space-y-8">
      <div>
        <p className="eyebrow">Thông tin nhận hàng</p>
        <h2 className="mt-3 font-display text-3xl md:text-4xl">Giao hàng COD</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-black/60">
          Không cần đăng ký tài khoản. {BRAND.identity.name} sẽ liên hệ qua số điện thoại để xác nhận đơn trước khi giao.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="text-sm font-medium" htmlFor="checkout-name">
          Họ và tên
          <input
            autoComplete="name"
            className={fieldClassName}
            id="checkout-name"
            maxLength={2048}
            name="name"
            required
            type="text"
          />
        </label>
        <label className="text-sm font-medium" htmlFor="checkout-phone">
          Số điện thoại
          <input
            autoComplete="tel"
            className={fieldClassName}
            id="checkout-phone"
            inputMode="tel"
            maxLength={2048}
            name="phone"
            required
            type="tel"
          />
        </label>
      </div>

      <fieldset className="space-y-5" disabled={isSubmitting || lockSubmission}>
        <legend className="text-sm font-semibold uppercase tracking-[0.12em]">
          Địa chỉ giao hàng
        </legend>
        <p className="text-sm leading-6 text-black/60">
          Hãy chọn tỉnh/thành, quận/huyện và phường/xã đúng với thông tin giao hàng của bạn.
        </p>

        <div className="grid gap-5 md:grid-cols-3">
          <label className="text-sm font-medium" htmlFor="checkout-province">
            Tỉnh / Thành phố
            <select
              className={fieldClassName}
              disabled={provinceLoading || provinces.length === 0}
              id="checkout-province"
              name="provinceRef"
              onChange={(event) => handleProvinceChange(event.target.value)}
              required
              value={provinceRef}
            >
              <option value="">
                {provinceLoading ? "Đang tải tỉnh/thành…" : "Chọn tỉnh/thành"}
              </option>
              {provinces.map((province) => (
                <option key={province.id} value={province.id}>
                  {province.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm font-medium" htmlFor="checkout-district">
            Quận / Huyện
            <select
              className={fieldClassName}
              disabled={!provinceRef || districtLoading || districts.length === 0}
              id="checkout-district"
              name="districtRef"
              onChange={(event) => handleDistrictChange(event.target.value)}
              required
              value={districtRef}
            >
              <option value="">
                {districtLoading ? "Đang tải quận/huyện…" : "Chọn quận/huyện"}
              </option>
              {districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm font-medium" htmlFor="checkout-commune">
            Phường / Xã
            <select
              className={fieldClassName}
              disabled={!districtRef || communeLoading || communes.length === 0}
              id="checkout-commune"
              name="communeRef"
              onChange={(event) => {
                setCommuneRef(event.target.value);
                setGeoError(null);
              }}
              required
              value={communeRef}
            >
              <option value="">
                {communeLoading ? "Đang tải phường/xã…" : "Chọn phường/xã"}
              </option>
              {communes.map((commune) => (
                <option key={commune.id} value={commune.id}>
                  {commune.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {geoError ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 border border-black/25 px-4 py-3 text-sm"
            role="status"
          >
            <span>{geoError.message}</span>
            <button
              className="font-semibold uppercase tracking-[0.1em] underline underline-offset-4"
              onClick={retryGeoRead}
              type="button"
            >
              Thử lại
            </button>
          </div>
        ) : null}

        <label className="block text-sm font-medium" htmlFor="checkout-detail">
          Số nhà, tên đường
          <input
            autoComplete="street-address"
            className={fieldClassName}
            id="checkout-detail"
            maxLength={2048}
            name="detail"
            required
            type="text"
          />
        </label>

        <label className="block text-sm font-medium" htmlFor="checkout-note">
          Ghi chú <span className="font-normal text-black/60">(không bắt buộc)</span>
          <textarea
            className={`${fieldClassName} min-h-28 resize-y`}
            id="checkout-note"
            maxLength={2048}
            name="note"
          />
        </label>
      </fieldset>
      </div>

      {/* Same breakpoint split as the summary above: the shipping/total block and the fulfillment
          notice belong between the fields and the submit button below `lg`, and inside the sticky
          aside at `lg+`. */}
      {totalsSlot ? <div className="checkout-totals lg:hidden">{totalsSlot}</div> : null}
      {preorderSlot ? <div className="checkout-preorder lg:hidden">{preorderSlot}</div> : null}

      {feedback ? (
        <div
          aria-live={feedback.tone === "success" ? "polite" : "assertive"}
          className={`border px-5 py-4 ${feedbackTone}`}
          role="status"
        >
          <p className="font-semibold">{feedback.title}</p>
          <p className="mt-1 text-sm leading-6 opacity-80">{feedback.message}</p>
          {!feedback.mayRetry && !submitState?.ok ? (
            <Link className="mt-3 inline-block text-sm font-semibold underline underline-offset-4" href="/cart">
              Quay lại giỏ hàng
            </Link>
          ) : null}
        </div>
      ) : null}

      <button
        className="w-full border border-black bg-black px-6 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-white transition hover:bg-transparent hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:border-black/20 disabled:bg-black/15 disabled:text-black/45"
        disabled={submitDisabled}
        type="submit"
      >
        {isSubmitting ? "Đang đặt hàng…" : "Đặt hàng COD"}
      </button>

      <p className="text-xs leading-5 text-black/60">
        Giá, tồn kho, phí vận chuyển và địa chỉ sẽ được kiểm tra lại khi bạn đặt hàng.
      </p>
    </form>
  );
}
