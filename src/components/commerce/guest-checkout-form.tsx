"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  loadCheckoutCommunesAction,
  loadCheckoutProvincesAction,
} from "@/commerce/checkout-geo-actions";
import { BRAND } from "@/brand";
import type { CheckoutCommune, CheckoutProvince } from "@/commerce/checkout-geo";
import { checkoutSubmitFeedback } from "@/commerce/checkout-submit-feedback";
import { submitGuestCheckoutAction } from "@/commerce/guest-checkout-actions";
import { isVietnamPhone, VIETNAM_PHONE_ERROR } from "@/commerce/vietnam-phone";

import { BrandCartGiftPicker } from "@/components/brand/cart-gift-picker";
import { CheckoutGiftReminderDialog } from "@/components/brand/checkout-gift-reminder-dialog";
import { useCheckoutGiftReminder } from "@/components/headless/use-checkout-gift-reminder";
import { reminderSubmitDecision } from "@/components/headless/checkout-gift-reminder-model";
import type { CartGiftPickerModel } from "@/routes/cart-gift-model";
import { CheckoutUpsell } from "./checkout-upsell";
import type { CheckoutUpsellModel } from "@/commerce/promotion-upsell";

type GeoError = Readonly<{
  level: "provinces" | "communes";
  message: string;
}>;

/** The fields a buyer must fill, in the order the form shows them (and focus moves through). */
const REQUIRED_FIELDS = ["name", "phone", "province", "commune", "detail"] as const;
type RequiredField = (typeof REQUIRED_FIELDS)[number];

const FIELD_INPUT_IDS: Record<RequiredField, string> = {
  name: "checkout-name",
  phone: "checkout-phone",
  province: "checkout-province",
  commune: "checkout-commune",
  detail: "checkout-detail",
};

const MISSING_MESSAGES: Record<RequiredField, string> = {
  name: "Vui lòng nhập họ và tên người nhận.",
  phone: "Vui lòng nhập số điện thoại.",
  province: "Vui lòng chọn tỉnh/thành phố.",
  commune: "Vui lòng chọn phường/xã.",
  detail: "Vui lòng nhập số nhà, tên đường.",
};

type FieldValues = Readonly<{
  name: string;
  phone: string;
  province: string;
  commune: string;
  detail: string;
}>;

/**
 * What is still missing or wrong, per field. The server re-checks all of it — this only lets the
 * buyer see every problem at once, in their language, before a round trip.
 */
function findFieldErrors(values: FieldValues): Partial<Record<RequiredField, string>> {
  const errors: Partial<Record<RequiredField, string>> = {};
  for (const field of REQUIRED_FIELDS) {
    if (values[field].trim().length === 0) errors[field] = MISSING_MESSAGES[field];
  }
  if (!errors.phone && !isVietnamPhone(values.phone)) {
    errors.phone = VIETNAM_PHONE_ERROR;
  }
  return errors;
}

const fieldClassName =
  "mt-2 w-full border border-black/25 bg-transparent px-4 py-3 text-base outline-none transition focus:border-black focus:ring-2 focus:ring-black/10 disabled:cursor-not-allowed disabled:bg-black/[0.04] disabled:text-black/45 aria-invalid:border-[#b42318] aria-invalid:focus:ring-[#b42318]/15";

const geoFailures = {
  provinces: {
    level: "provinces",
    message: "Chưa tải được danh sách tỉnh/thành. Vui lòng thử lại.",
  },
  communes: {
    level: "communes",
    message: "Chưa tải được danh sách phường/xã. Vui lòng thử lại.",
  },
} as const satisfies Record<GeoError["level"], GeoError>;

/**
 * GQ19 -- what the form needs to carry a gift / quantity-tier checkout.
 *
 * `digest` identifies the exact quote on screen. The acknowledgement is stored against it, so when a
 * refreshed render brings a different quote the box is unticked by construction -- there is no
 * effect that has to remember to reset it.
 */
export type GuestCheckoutBenefit = Readonly<{
  digest: string;
  needsAcknowledgement: boolean;
  unclaimedText: string | null;
  acknowledgementLabel: string | null;
  tierNotice: string | null;
}>;


export function GuestCheckoutForm({
  quoteProof,
  giftPicker,
  attemptKey,
  unavailableNotice,
  benefit,
  upsell,
  summaryLabel,
  summarySlot,
  totalsSlot,
  preorderSlot,
  desktopPreorderSlot,
}: Readonly<{
  quoteProof: string | null;
  giftPicker?: CartGiftPickerModel;
  attemptKey?: string;
  unavailableNotice?: string | null;
  upsell?: CheckoutUpsellModel;
  benefit?: GuestCheckoutBenefit;
  summaryLabel?: string;
  summarySlot?: ReactNode;
  totalsSlot?: ReactNode;
  preorderSlot?: ReactNode;
    desktopPreorderSlot?: ReactNode;
}>) {
  const [submitState, submitAction, isSubmitting] = useActionState(
    submitGuestCheckoutAction,
    null,
  );
  const router = useRouter();
  const [upsellPending, setUpsellPending] = useState(false);
  const [isRefreshingQuote, startQuoteRefresh] = useTransition();
  const [provinces, setProvinces] = useState<CheckoutProvince[]>([]);
  const [communes, setCommunes] = useState<CheckoutCommune[]>([]);
  const [provinceRef, setProvinceRef] = useState("");
  const [communeRef, setCommuneRef] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [detail, setDetail] = useState("");
  const [note, setNote] = useState("");
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [giftPending, setGiftPending] = useState(false);
  const coordinatedBusy = useRef(false);
  const submissionBusy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const paymentRef = useRef<HTMLHeadingElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const reminder = useCheckoutGiftReminder(attemptKey);
  const onGiftBusyChange = useCallback((value: boolean) => { coordinatedBusy.current = value; setGiftPending(value); }, []);
  const onUpsellBusyChange = useCallback((value: boolean) => { coordinatedBusy.current = value; setUpsellPending(value); }, []);
  const isInteractionLocked = useCallback(() => coordinatedBusy.current || submissionBusy.current, []);
  const [provinceLoading, setProvinceLoading] = useState(true);
  const [communeLoading, setCommuneLoading] = useState(false);
  const [geoError, setGeoError] = useState<GeoError | null>(null);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  // Warnings appear once the buyer has tried to place the order (or left the phone field), then
  // update live as they fix each field, so a corrected field clears its own message immediately.
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const summaryContentId = useId();
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);
  const provinceRequest = useRef(0);
  const communeRequest = useRef(0);

  const requestProvinces = useCallback(async () => {
    const requestId = ++provinceRequest.current;
    ++communeRequest.current;
    setProvinceLoading(true);
    setCommuneLoading(false);
    setGeoError(null);
    setProvinceRef("");
    setCommuneRef("");
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

  const requestCommunes = useCallback(async (selectedProvince: string) => {
    const requestId = ++communeRequest.current;
    setCommuneLoading(true);
    setGeoError(null);

    try {
      const result = await loadCheckoutCommunesAction(selectedProvince);
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
  }, []);

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
  // Missing fields no longer disable the button: pressing it is how the buyer finds out what is
  // left, so it stays pressable and answers with the warnings below. It is disabled only while a
  // submission or quote refresh is in flight, after a final outcome, or when the address lists
  // could not be loaded at all (the retry button is the way forward then).
  const submitDisabled =
    !quoteProof || isSubmitting || giftPending || upsellPending || Boolean(geoError) || isRefreshingQuote || lockSubmission;

  const fieldErrors = findFieldErrors({
    name,
    phone,
    province: provinceRef,
    commune: communeRef,
    detail,
  });
  const visibleErrors: Partial<Record<RequiredField, string>> = showAllErrors
    ? fieldErrors
    : phoneTouched && phone.trim().length > 0 && fieldErrors.phone
      ? { phone: fieldErrors.phone }
      : {};
  const hasMissingFields = showAllErrors && Object.keys(fieldErrors).length > 0;


  function errorId(field: RequiredField): string {
    return `${FIELD_INPUT_IDS[field]}-error`;
  }

  function fieldA11y(field: RequiredField) {
    return visibleErrors[field]
      ? { "aria-invalid": true as const, "aria-describedby": errorId(field) }
      : {};
  }

  function renderFieldError(field: RequiredField) {
    const message = visibleErrors[field];
    return message ? (
      <span className="mt-2 block text-sm font-normal text-[#b42318]" id={errorId(field)}>
        {message}
      </span>
    ) : null;
  }

  // One pipeline for form, Enter and dialog intent. Claim is attached only to this FormData.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled || coordinatedBusy.current || submissionBusy.current || reminder.current.current === "open") return;
    if (Object.keys(fieldErrors).length > 0) {
      setShowAllErrors(true);
      const first = REQUIRED_FIELDS.find((field) => fieldErrors[field]);
      requestAnimationFrame(() => {
        errorSummaryRef.current?.scrollIntoView({block: "center"});
        if (first) document.getElementById(FIELD_INPUT_IDS[first])?.focus();
      });
      return;
    }
    const decision = reminderSubmitDecision({ state: reminder.current.current, valid: true, busy: false, needsReminder: benefit?.needsAcknowledgement === true });
    if (decision === "remind") { reminder.open(); return; }
    if (decision !== "submit") return;
    submissionBusy.current = true;
    const formData = new FormData(event.currentTarget);
    if (benefit?.needsAcknowledgement && reminder.current.current === "seen") formData.set("nonclaimAcknowledged", "yes");
    startTransition(() => submitAction(formData));
  }
  useEffect(() => {
    if (!isSubmitting) submissionBusy.current = false;
    if (submitState?.ok) reminder.clear();
  }, [isSubmitting, submitState, reminder]);
  // Do not leave a modal presenting an old quote after the route becomes unavailable.
  useEffect(() => {
    if (!quoteProof && reminder.current.current === "open") reminder.markSeen();
  }, [quoteProof, reminder]);
  function returnToPayment() {
    paymentRef.current?.focus();
    paymentRef.current?.scrollIntoView({block: "center", behavior: "smooth"});
  }
  function chooseGifts() {
    reminder.markSeen();
    requestAnimationFrame(() => {
      const section = document.getElementById("cart-gifts");
      const toggle = section?.querySelector<HTMLButtonElement>("button[aria-controls]");
      if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
      section?.focus(); section?.scrollIntoView({block: "start", behavior: "smooth"});
    });
  }

  function handleProvinceChange(value: string) {
    setProvinceRef(value);
    setCommuneRef("");
    setCommunes([]);
    setGeoError(null);

    if (!value) {
      ++communeRequest.current;
      setCommuneLoading(false);
      return;
    }
    void requestCommunes(value);
  }

  function retryGeoRead() {
    if (!geoError) return;
    if (geoError.level === "provinces") {
      void requestProvinces();
      return;
    }
    if (geoError.level === "communes" && provinceRef) {
      void requestCommunes(provinceRef);
    }
  }

  const feedbackTone =
    feedback?.tone === "success"
      ? "border-black bg-black text-white"
      : feedback?.tone === "warning"
        ? "border-black/35 bg-black/[0.04] text-black"
        : "border-black bg-transparent text-black";

  return (
    <form ref={formRef} action={submitAction} className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)] lg:gap-x-16" noValidate onSubmit={handleSubmit}>
      {/* Opaque, server-authenticated, and always the token issued by the render currently on
          screen. Editing it cannot change what the buyer is charged: the server recomputes the price
          itself and only asks this token whether that price is the one it already showed. A tampered
          or swapped value simply fails closed into re-confirmation. */}
      <input name="quoteProof" type="hidden" value={quoteProof ?? ""} />

      <aside className="checkout-order-panel min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-24 lg:self-start">
      {summarySlot ? <div className="hidden lg:block"><p className="mb-5 text-xs font-semibold uppercase tracking-[0.14em]">Đơn hàng</p>{summarySlot}</div> : null}
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

      {giftPicker ? <BrandCartGiftPicker model={giftPicker} onBusyChange={onGiftBusyChange} locked={isSubmitting || upsellPending || isRefreshingQuote || lockSubmission} isLocked={isInteractionLocked} onDraftChange={setDraftNotice} onReturnToPayment={returnToPayment} /> : null}
      {totalsSlot ? <div className="hidden lg:block">{totalsSlot}</div> : null}
      {desktopPreorderSlot ? <div className="hidden lg:block">{desktopPreorderSlot}</div> : null}
      </aside>

      <div className="checkout-receiving-fields min-w-0 space-y-8 lg:col-start-1 lg:row-start-1">
      {upsell ? <CheckoutUpsell model={upsell} locked={isSubmitting || giftPending || isRefreshingQuote || lockSubmission} isLocked={isInteractionLocked} onBusyChange={onUpsellBusyChange} /> : null}
      <div>
        <p className="eyebrow">Thông tin nhận hàng</p>
        <h2 className="mt-3 font-display text-3xl md:text-4xl">Giao hàng COD</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-black/60">
          Không cần đăng ký tài khoản. {BRAND.identity.name} sẽ liên hệ qua số điện thoại để xác nhận đơn trước khi giao.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium" htmlFor="checkout-name">
            Họ và tên <RequiredMark />
            <input
              autoComplete="name"
              className={fieldClassName}
              id="checkout-name"
              maxLength={2048}
              name="name"
              onChange={(event) => setName(event.target.value)}
              required
              type="text"
              value={name}
              {...fieldA11y("name")}
            />
          </label>
          {renderFieldError("name")}
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="checkout-phone">
            Số điện thoại <RequiredMark />
            <input
              autoComplete="tel"
              className={fieldClassName}
              id="checkout-phone"
              inputMode="tel"
              maxLength={32}
              name="phone"
              onBlur={() => setPhoneTouched(true)}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="VD: 0912 345 678"
              required
              type="tel"
              value={phone}
              {...fieldA11y("phone")}
            />
          </label>
          {renderFieldError("phone")}
        </div>
      </div>

      <fieldset className="space-y-5" disabled={isSubmitting || lockSubmission}>
        <legend className="text-sm font-semibold uppercase tracking-[0.12em]">
          Địa chỉ giao hàng
        </legend>
        <p className="text-sm leading-6 text-black/60">
          Địa chỉ theo đơn vị hành chính mới: chọn tỉnh/thành phố, phường/xã, rồi nhập số nhà, tên đường.
        </p>

        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="checkout-province">
              Tỉnh / Thành phố <RequiredMark />
              <select
                className={fieldClassName}
                disabled={provinceLoading || provinces.length === 0}
                id="checkout-province"
                name="provinceRef"
                onChange={(event) => handleProvinceChange(event.target.value)}
                required
                value={provinceRef}
                {...fieldA11y("province")}
              >
                <option value="">
                  {provinceLoading ? "Đang tải tỉnh/thành…" : "Chọn tỉnh/thành phố"}
                </option>
                {provinces.map((province) => (
                  <option key={province.id} value={province.id}>
                    {province.name}
                  </option>
                ))}
              </select>
            </label>
            {renderFieldError("province")}
          </div>

          <div>
            <label className="block text-sm font-medium" htmlFor="checkout-commune">
              Phường / Xã <RequiredMark />
              <select
                className={fieldClassName}
                disabled={!provinceRef || communeLoading || communes.length === 0}
                id="checkout-commune"
                name="communeRef"
                onChange={(event) => {
                  setCommuneRef(event.target.value);
                  setGeoError(null);
                }}
                required
                value={communeRef}
                {...fieldA11y("commune")}
              >
                <option value="">
                  {communeLoading
                    ? "Đang tải phường/xã…"
                    : provinceRef
                      ? "Chọn phường/xã"
                      : "Chọn tỉnh/thành phố trước"}
                </option>
                {communes.map((commune) => (
                  <option key={commune.id} value={commune.id}>
                    {commune.name}
                  </option>
                ))}
              </select>
            </label>
            {renderFieldError("commune")}
          </div>
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

        <div className="block">
          <label className="block text-sm font-medium" htmlFor="checkout-detail">
            Số nhà, tên đường <RequiredMark />
            <input
              autoComplete="street-address"
              className={fieldClassName}
              id="checkout-detail"
              maxLength={2048}
              name="detail"
              onChange={(event) => setDetail(event.target.value)}
              placeholder="VD: 12 Nguyễn Trãi"
              required
              type="text"
              value={detail}
              {...fieldA11y("detail")}
            />
          </label>
          {renderFieldError("detail")}
        </div>

        <label className="block text-sm font-medium" htmlFor="checkout-note">
          Ghi chú <span className="font-normal text-black/60">(không bắt buộc)</span>
          <textarea
            className={`${fieldClassName} min-h-28 resize-y`}
            id="checkout-note"
            maxLength={2048}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </fieldset>
      </div>

      {/* Same breakpoint split as the summary above: the shipping/total block and the fulfillment
          notice belong between the fields and the submit button below `lg`, and inside the sticky
          aside at `lg+`. */}
      <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-2">
      <h2 ref={paymentRef} tabIndex={-1} className="scroll-mt-32 font-display text-2xl">Tổng kết thanh toán</h2>
      {unavailableNotice ? <div role="alert"><p>{unavailableNotice}</p><button type="button" className="mt-2 min-h-11 underline" disabled={isRefreshingQuote || giftPending} onClick={() => startQuoteRefresh(() => router.refresh())}>Kiểm tra lại báo giá</button><Link href="/cart" className="ml-4 text-sm underline">Quay lại giỏ hàng</Link></div> : null}
      {benefit?.tierNotice ? <p role="status" className="text-sm">{benefit.tierNotice}</p> : null}
      {draftNotice ? <p className="text-sm" data-payment-gift-draft>{draftNotice}</p> : null}
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

      {/* One line beside the button; which fields need attention is shown in red on each field above. */}
      {hasMissingFields ? (
        <p
          className="border border-[#b42318] px-5 py-4 text-sm font-semibold text-[#b42318]"
          ref={errorSummaryRef}
          role="alert"
        >
          Vui lòng điền đầy đủ thông tin.
        </p>
      ) : null}

      <button
        className="btn btn--primary w-full py-4"
        disabled={submitDisabled}
        ref={submitButton}
        type="submit"
      >
        {isSubmitting ? "Đang đặt hàng…" : "Đặt hàng COD"}
      </button>

      <p className="text-xs leading-5 text-black/60">
        Giá, tồn kho, phí vận chuyển và địa chỉ sẽ được kiểm tra lại khi bạn đặt hàng.
      </p>
      </div>
      <CheckoutGiftReminderDialog open={reminder.state === "open"} disabled={submitDisabled} description={benefit?.unclaimedText ?? "Bạn còn quà chưa chọn."} canChoose={Boolean(giftPicker?.campaigns.some((c) => (c.selectable ?? 0) > 0))} onShown={reminder.recordShown} onClose={() => { reminder.markSeen(); submitButton.current?.focus(); }} onChoose={chooseGifts} onContinue={() => { reminder.markSeen(); formRef.current?.requestSubmit(); }} />
    </form>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-[#b42318]">
      *
    </span>
  );
}
