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
import { effectivePaymentMethod } from "@/commerce/payment-method";
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
import { MobileStickyCta } from "@/components/brand/mobile-sticky-cta";
import type { CheckoutUpsellBanner } from "@/routes/checkout-model";

const EMPTY_GIFT_PICKER: CartGiftPickerModel = { campaigns: [], selections: [], invalid: false, stackConflict: false };

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
  name: "Nàng nhập họ tên người nhận nhé.",
  phone: "Nàng nhập số điện thoại nhé.",
  province: "Nàng chọn tỉnh/thành phố nhé.",
  commune: "Nàng chọn phường/xã nhé.",
  detail: "Nàng nhập số nhà, tên đường nhé.",
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

// In-field labels: the label sits inside the compact rounded box like a placeholder and disappears
// once the field holds a value (owner request 2026-10-18). It stays the field's real <label>, so the
// accessible name never depends on it being visible. `placeholder=" "` lets CSS tell "filled" apart.
const fieldClassName =
  "peer block h-11 w-full rounded-xl border border-black/20 bg-white px-3.5 text-base outline-none transition-colors focus:border-black focus:ring-2 focus:ring-black/10 disabled:cursor-not-allowed disabled:bg-black/[0.04] disabled:text-black/45 aria-invalid:border-[#b42318] aria-invalid:focus:ring-[#b42318]/15";
const inFieldLabelClassName =
  "pointer-events-none absolute inset-x-3.5 top-1/2 -translate-y-1/2 truncate text-base text-black/60 peer-[:not(:placeholder-shown)]:opacity-0";
// A select already shows "Chọn …" while empty, so its label is for assistive technology only.
const selectLabelClassName = "sr-only";

function SelectChevron() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/60" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const geoFailures = {
  provinces: {
    level: "provinces",
    message: "Chưa tải được danh sách tỉnh/thành, nàng thử lại nhé.",
  },
  communes: {
    level: "communes",
    message: "Chưa tải được danh sách phường/xã, nàng thử lại nhé.",
  },
} as const satisfies Record<GeoError["level"], GeoError>;

/**
 * GQ19 -- what the form needs to carry a gift / quantity-tier checkout.
 *
 * `digest` identifies the exact quote on screen. Reminder lifetime uses the separate cart-bound UI
 * key; acknowledgement is attached only to an explicit submit, never stored with the reminder.
 */
export type GuestCheckoutBenefit = Readonly<{
  digest: string;
  needsAcknowledgement: boolean;
  unclaimedText: string | null;
  acknowledgementLabel: string | null;
  tierNotice: string | null;
}>;


const SUBMIT_BUTTON_ID = "checkout-submit";

export function GuestCheckoutForm({
  quoteProof,
  totalVnd,
  totalText,
  giftPicker,
  attemptKey,
  quoteRenderId,
  unavailableNotice,
  benefit,
  upsell,
  summaryLabel,
  summarySlot,
  totalsSlot,
  preorderSlot,
  desktopPreorderSlot,
  bankTransferEnabled = false,
}: Readonly<{
  quoteProof: string | null;
  /** The total of the quote on screen; only used to say "old → new" after a price change. */
  totalVnd?: number;
  /** The same total, formatted, for the mobile bottom bar. */
  totalText?: string;
  giftPicker?: CartGiftPickerModel;
  attemptKey?: string;
  quoteRenderId?: string;
  unavailableNotice?: string | null;
  upsell?: CheckoutUpsellBanner;
  benefit?: GuestCheckoutBenefit;
  summaryLabel?: string;
  summarySlot?: ReactNode;
  totalsSlot?: ReactNode;
  preorderSlot?: ReactNode;
  desktopPreorderSlot?: ReactNode;
  /** Offer bank transfer beside COD. The server refuses the method too when it is off. */
  bankTransferEnabled?: boolean;
}>) {
  const [submitState, submitAction, isSubmitting] = useActionState(
    submitGuestCheckoutAction,
    null,
  );
  const router = useRouter();
  const [isRefreshingQuote, startQuoteRefresh] = useTransition();
  const [provinces, setProvinces] = useState<CheckoutProvince[]>([]);
  const [communes, setCommunes] = useState<CheckoutCommune[]>([]);
  const [provinceRef, setProvinceRef] = useState("");
  const [communeRef, setCommuneRef] = useState("");
  const [submittedRenderId, setSubmittedRenderId] = useState<string | undefined>();
  const [submittedTotalVnd, setSubmittedTotalVnd] = useState<number | undefined>();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [detail, setDetail] = useState("");
  const [note, setNote] = useState("");
  const [chosenPaymentMethod, setPaymentMethod] = useState<"COD" | "BANK_TRANSFER">("COD");
  // `bankTransferEnabled` can flip to false on a refresh while this state survives; the radios are
  // gone then, so the button and the hint must follow the prop, not the stale choice.
  const paymentMethod = effectivePaymentMethod(bankTransferEnabled, chosenPaymentMethod);
  // Masking is not enough: a choice kept while the method is off would come back on its own when
  // a later refresh turns it on again. Clear it the moment the two disagree (set during render, the
  // documented way to reset state from a prop).
  if (paymentMethod !== chosenPaymentMethod) setPaymentMethod(paymentMethod);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [giftPending, setGiftPending] = useState(false);
  const coordinatedBusy = useRef({ gifts: false, quote: false });
  const submissionBusy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const paymentRef = useRef<HTMLHeadingElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const reminder = useCheckoutGiftReminder(attemptKey);
  const onGiftBusyChange = useCallback((value: boolean) => { coordinatedBusy.current.gifts = value; setGiftPending(value); }, []);
  const isInteractionLocked = useCallback(() => Object.values(coordinatedBusy.current).some(Boolean) || submissionBusy.current, []);
  const refreshQuote = useCallback(() => {
    coordinatedBusy.current.quote = true;
    startQuoteRefresh(() => router.refresh());
  }, [router]);
  useEffect(() => { coordinatedBusy.current.quote = isRefreshingQuote; }, [isRefreshingQuote]);
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
    if (submitState && !submitState.ok && (submitState.status === "PRICE_CHANGED" || (submitState.status === "RETRYABLE" && submitState.giftRepairRequired))) {
      refreshQuote();
    }
  }, [submitState, refreshQuote]);

  const feedback = submitState ? checkoutSubmitFeedback(submitState, { submittedTotalVnd }) : null;
  const lockSubmission = feedback ? !feedback.mayRetry : false;
  // Missing fields no longer disable the button: pressing it is how the buyer finds out what is
  // left, so it stays pressable and answers with the warnings below. It is disabled only while a
  // submission or quote refresh is in flight, after a final outcome, or when the address lists
  // could not be loaded at all (the retry button is the way forward then).
  const waitingForNewRender = Boolean(submitState && !submitState.ok && (submitState.status === "PRICE_CHANGED" || (submitState.status === "RETRYABLE" && submitState.giftRepairRequired)) && submittedRenderId === quoteRenderId);
  const submitDisabled =
    waitingForNewRender || !quoteProof || isSubmitting || giftPending || Boolean(geoError) || isRefreshingQuote || lockSubmission;

  // UX-08: a disabled button always says why, beside it, in the same words the bar below repeats.
  // A final outcome is already explained by the feedback block right above the button.
  const submitLockReason = isSubmitting || lockSubmission ? null
    : !quoteProof ? (unavailableNotice ? "Giỏ hàng cần xem lại một chút, nàng xem hướng dẫn ở đầu trang nhé." : "Giá chưa được cập nhật, nàng tải lại trang nhé.")
    : giftPending ? "Đang lưu quà tặng…"
    : isRefreshingQuote || waitingForNewRender ? "Đang cập nhật giá mới…"
    : geoError ? "Chưa tải được địa chỉ, nàng bấm “Thử lại” ở phần địa chỉ nhé."
    : null;
  const submitReasonId = useId();

  // UX-10: a standing line above the button. Information only -- it is not the one-time reminder,
  // never marks the reminder as shown and never acknowledges a gift the buyer is not taking.
  const giftModel = giftPicker ?? EMPTY_GIFT_PICKER;
  const choosableGifts = giftModel.campaigns.reduce((sum, row) => sum + (row.selectable ?? 0), 0);
  const unclaimedGifts = giftModel.campaigns.reduce((sum, row) => sum + row.unclaimed, 0);
  // Campaigns that share gift stock each count the shared slots, so their sum overstates what can be
  // taken; like the picker, name no number then (never sum competing campaign maxima).
  const sharedGiftStock = giftModel.campaigns.some((row) => row.contendedSlots > 0);
  const giftHint = !quoteProof || giftModel.invalid || unclaimedGifts === 0 ? null
    : choosableGifts > 0 ? { canChoose: true, text: sharedGiftStock ? "Nàng còn quà chưa chọn." : `Nàng còn ${choosableGifts} món quà chưa chọn.` }
    : { canChoose: false, text: "Một phần quà tạm chưa có mẫu phù hợp." };

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
    if (submitDisabled || isInteractionLocked() || reminder.current.current === "open") return;
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
    setSubmittedRenderId(quoteRenderId);
    // The total of the render this submit is made against, so a refusal can say "old → new".
    setSubmittedTotalVnd(totalVnd);
    const formData = new FormData(event.currentTarget);
    if (benefit?.needsAcknowledgement && reminder.current.current === "seen") formData.set("nonclaimAcknowledged", "yes");
    startTransition(() => submitAction(formData));
  }
  useEffect(() => {
    if (!isSubmitting && !isRefreshingQuote && !waitingForNewRender) submissionBusy.current = false;
    if (submitState?.ok) reminder.clear();
  }, [isSubmitting, isRefreshingQuote, waitingForNewRender, submitState, reminder]);
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
    openGiftPicker();
  }
  function openGiftPicker() {
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
    <form ref={formRef} data-checkout-render={quoteRenderId} action={submitAction} className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)] lg:gap-x-16" noValidate onSubmit={handleSubmit}>
      {/* Opaque, server-authenticated, and always the token issued by the render currently on
          screen. Editing it cannot change what the buyer is charged: the server recomputes the price
          itself and only asks this token whether that price is the one it already showed. A tampered
          or swapped value simply fails closed into re-confirmation. */}
      <input name="quoteProof" type="hidden" value={quoteProof ?? ""} />

      <aside className="checkout-order-panel min-w-0 lg:col-start-2 lg:row-start-1 lg:sticky lg:top-24 lg:self-start">
      {summarySlot ? <div className="checkout-desktop-lines hidden lg:block"><p className="mb-5 text-xs font-semibold uppercase tracking-[0.14em]">Đơn hàng</p>{summarySlot}</div> : null}
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

      <BrandCartGiftPicker model={giftPicker ?? EMPTY_GIFT_PICKER} onBusyChange={onGiftBusyChange} locked={isSubmitting || isRefreshingQuote || lockSubmission} isLocked={isInteractionLocked} onDraftChange={setDraftNotice} onReturnToPayment={returnToPayment} />
      {totalsSlot ? <div className="hidden lg:block">{totalsSlot}</div> : null}
      {desktopPreorderSlot ? <div className="hidden lg:block">{desktopPreorderSlot}</div> : null}
      </aside>

      <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
      <div className="checkout-receiving-fields min-w-0 space-y-5">
      {/* UX-08: why the order cannot be placed, and how to fix it, before the first field. */}
      {unavailableNotice ? <div id="checkout-blocking-notice" tabIndex={-1} role="alert" className="border border-[#b42318]/50 px-4 py-3 text-sm"><p className="font-semibold">Giỏ hàng cần xem lại một chút</p><p className="mt-1 leading-6">{unavailableNotice}</p><div className="flex flex-wrap items-center gap-x-4"><button type="button" className="min-h-11 underline" disabled={isRefreshingQuote || giftPending || isSubmitting} onClick={refreshQuote}>Cập nhật giá</button><Link href="/cart" className="min-h-11 content-center underline">Quay lại giỏ hàng</Link></div></div> : null}
      {upsell ? <CheckoutUpsell model={upsell} locked={isSubmitting || lockSubmission} /> : null}
      <h2 className="font-display text-2xl">Thông tin nhận hàng</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="relative">
            <input
              autoComplete="name"
              className={fieldClassName}
              id="checkout-name"
              maxLength={2048}
              name="name"
              onChange={(event) => setName(event.target.value)}
              placeholder=" "
              required
              type="text"
              value={name}
              {...fieldA11y("name")}
            />
            <label className={inFieldLabelClassName} htmlFor="checkout-name">
              Họ và tên <RequiredMark />
            </label>
          </div>
          {renderFieldError("name")}
        </div>
        <div>
          <div className="relative">
            <input
              autoComplete="tel"
              className={fieldClassName}
              id="checkout-phone"
              inputMode="tel"
              maxLength={32}
              name="phone"
              onBlur={() => setPhoneTouched(true)}
              onChange={(event) => setPhone(event.target.value)}
              placeholder=" "
              required
              type="tel"
              value={phone}
              {...fieldA11y("phone")}
            />
            <label className={inFieldLabelClassName} htmlFor="checkout-phone">
              Số điện thoại <RequiredMark />
            </label>
          </div>
          {renderFieldError("phone")}
        </div>
      </div>

      <fieldset className="space-y-3" disabled={isSubmitting || lockSubmission}>
        <legend className="mb-3 text-sm font-semibold uppercase tracking-[0.12em]">
          Địa chỉ giao hàng <span className="font-normal normal-case tracking-normal text-black/60">(địa chỉ mới)</span>
        </legend>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="relative">
              <select
                className={`${fieldClassName} appearance-none pr-10 [&>option]:text-black ${provinceRef ? "" : "text-black/60"}`}
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
              <label className={selectLabelClassName} htmlFor="checkout-province">
                Tỉnh / Thành phố <RequiredMark />
              </label>
              <SelectChevron />
            </div>
            {renderFieldError("province")}
          </div>

          <div>
            <div className="relative">
              <select
                className={`${fieldClassName} appearance-none pr-10 [&>option]:text-black ${communeRef ? "" : "text-black/60"}`}
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
              <label className={selectLabelClassName} htmlFor="checkout-commune">
                Phường / Xã <RequiredMark />
              </label>
              <SelectChevron />
            </div>
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

        <div>
          <div className="relative">
            <input
              autoComplete="street-address"
              className={fieldClassName}
              id="checkout-detail"
              maxLength={2048}
              name="detail"
              onChange={(event) => setDetail(event.target.value)}
              placeholder=" "
              required
              type="text"
              value={detail}
              {...fieldA11y("detail")}
            />
            <label className={inFieldLabelClassName} htmlFor="checkout-detail">
              Số nhà, tên đường <RequiredMark />
            </label>
          </div>
          {renderFieldError("detail")}
        </div>

        <div className="relative">
          <textarea
            className={`${fieldClassName} h-auto min-h-16 resize-y py-2.5`}
            rows={2}
            id="checkout-note"
            maxLength={2048}
            name="note"
            placeholder=" "
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <label className="pointer-events-none absolute inset-x-3.5 top-2.5 truncate text-base text-black/60 peer-[:not(:placeholder-shown)]:opacity-0" htmlFor="checkout-note">
            Ghi chú (không bắt buộc)
          </label>
        </div>
      </fieldset>
      </div>

      {/* Same breakpoint split as the summary above: the shipping/total block and the fulfillment
          notice belong between the fields and the submit button below `lg`, and inside the sticky
          aside at `lg+`. */}
      <div className="min-w-0 space-y-4">
      <h2 ref={paymentRef} tabIndex={-1} className="scroll-mt-32 font-display text-2xl">Tổng kết thanh toán</h2>
      {benefit?.tierNotice ? <p role="status" className="text-sm">{benefit.tierNotice}</p> : null}
      {draftNotice ? <p className="text-sm" data-payment-gift-draft>{draftNotice}</p> : null}
      {totalsSlot ? <div className="checkout-totals lg:hidden">{totalsSlot}</div> : null}
      {preorderSlot ? <div className="checkout-preorder lg:hidden">{preorderSlot}</div> : null}

      {bankTransferEnabled ? (
        <fieldset className="space-y-2" disabled={isSubmitting || lockSubmission}>
          <legend className="text-sm font-semibold">Phương thức thanh toán</legend>
          <label className="flex min-h-11 items-center gap-3 border border-black/20 px-4 text-sm">
            <input type="radio" name="paymentMethod" value="COD" checked={paymentMethod === "COD"} onChange={() => setPaymentMethod("COD")} />
            Thanh toán khi nhận hàng (COD)
          </label>
          <label className="flex min-h-11 items-center gap-3 border border-black/20 px-4 text-sm">
            <input type="radio" name="paymentMethod" value="BANK_TRANSFER" checked={paymentMethod === "BANK_TRANSFER"} onChange={() => setPaymentMethod("BANK_TRANSFER")} />
            Chuyển khoản ngân hàng
          </label>
          {paymentMethod === "BANK_TRANSFER" ? (
            <p className="text-sm leading-6 text-black/75" data-bank-transfer-hint>
              Thông tin chuyển khoản hiện ở trang xác nhận sau khi nàng đặt hàng. Đơn được giao sau khi shop nhận đủ tiền.
            </p>
          ) : null}
        </fieldset>
      ) : null}

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
          className="border border-[#b42318] px-4 py-3 text-sm font-semibold text-[#b42318]"
          ref={errorSummaryRef}
          role="alert"
        >
          Nàng điền nốt các ô còn trống nhé.
        </p>
      ) : null}

      {giftHint ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 border-t border-black/15 pt-2 text-sm" data-checkout-gift-hint>
          <p>{giftHint.text}</p>
          {giftHint.canChoose ? <button type="button" className="min-h-11 font-semibold underline underline-offset-4" onClick={openGiftPicker}>Chọn quà</button> : null}
        </div>
      ) : null}

      {/* Always mounted, so a reason that appears later is announced; empty and out of layout otherwise. */}
      <p id={submitReasonId} className="text-sm empty:hidden" aria-live="polite" data-checkout-submit-reason>{submitLockReason}</p>

      <button
        aria-describedby={submitLockReason ? submitReasonId : undefined}
        className="btn btn--primary w-full py-4"
        disabled={submitDisabled}
        id={SUBMIT_BUTTON_ID}
        ref={submitButton}
        type="submit"
      >
        {isSubmitting ? "Đang đặt hàng…" : paymentMethod === "BANK_TRANSFER" ? "Đặt hàng và chuyển khoản" : "Đặt hàng COD"}
      </button>

      {/* Room for the bottom bar, so it never sits over the last of the page. */}
      {totalText ? <div aria-hidden="true" className="h-24 lg:hidden" /> : null}
      </div>
      </div>
      {totalText ? (
        <MobileStickyCta targetId={SUBMIT_BUTTON_ID} totalText={totalText} suppressed={reminder.state === "open"} note={submitLockReason}>
          {/* Not a second submit: it asks the form to submit, so validation, the reminder and the single
              order all run through `handleSubmit` exactly as the primary button does. */}
          {/* Named apart from the primary button so assistive tech and tests can tell the two apart. */}
          <button type="button" className="btn btn--primary px-4" disabled={submitDisabled} onClick={() => formRef.current?.requestSubmit()}>
            {isSubmitting ? "Đang gửi…" : "Đặt hàng"}
          </button>
        </MobileStickyCta>
      ) : null}
      <CheckoutGiftReminderDialog open={reminder.state === "open"} disabled={submitDisabled} description={benefit?.unclaimedText ?? "Nàng còn quà chưa chọn."} canChoose={Boolean(giftPicker?.campaigns.some((c) => (c.selectable ?? 0) > 0))} onShown={reminder.recordShown} onClose={() => { reminder.markSeen(); submitButton.current?.focus(); }} onChoose={chooseGifts} onContinue={() => { reminder.markSeen(); formRef.current?.requestSubmit(); }} />
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
