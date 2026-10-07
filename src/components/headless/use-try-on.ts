"use client";

import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";

import { authClient } from "@/auth/client";

import {
  TRY_ON_NETWORK_FAILURE_MESSAGE,
  isBlockedAgeState,
  isFinalForPhoto,
  isTeenAgeState,
  isTryOnAgeAllowed,
  missingTryOnSteps,
  nextTryOnStep,
  parseTryOnFailureReason,
  tryOnStepNumber,
  tryOnFailureMessage,
  tryOnQuotaUpsell,
  validateTryOnFile,
  type TryOnAgeState,
  type TryOnFailureReason,
  type TryOnStep,
} from "./try-on-model.ts";

/**
 * Virtual try-on behaviour for a PDP dialog: the photo, the shopper's attestations, the one request
 * to `/api/try-on`, and its result.
 *
 * Isolation is the design constraint. This hook shares no state with the variant selection or the
 * cart and imports neither, so a failure here cannot change what the shopper is buying. It holds the
 * photo and the result only as in-memory blob URLs, revokes them when replaced, and `reset()` drops
 * everything when the dialog closes — nothing is written to browser storage.
 *
 * The dialog is a three-step wizard (`step`): photo, age and confirmation, result. Loading, success
 * and failure are all the result step, so the form is not on screen while a request is in flight.
 *
 * Everything the request is built from is also frozen while it runs, in the hook and not only in the
 * markup. The photo, the age attestation and the acknowledgement are snapshotted into the `FormData`
 * when the request starts; if they could change before it settles, the result would arrive beside a
 * preview and a teen disclosure that no longer describe the photo and attestation it was made from.
 * The setters below ignore changes while `locked`, whatever the markup does.
 *
 * It submits the photo, the product slug, the acknowledgement and the age state, and nothing else:
 * in particular no product image URL, because the server chooses the garment image itself.
 */

type Phase = "idle" | "loading" | "success" | "error";
export type TryOnResult = Readonly<{ url: string; mimeType: "image/png" | "image/jpeg" }>;

function decodeImage(base64: string, mimeType: TryOnResult["mimeType"]): TryOnResult {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { url: URL.createObjectURL(new Blob([bytes], { type: mimeType })), mimeType };
}

export function useTryOn({
  productSlug,
  fileInputRef,
}: Readonly<{
  productSlug: string;
  /** The markup's own file input, so a refused photo can be cleared without remounting (and losing focus). */
  fileInputRef: RefObject<HTMLInputElement | null>;
}>) {
  const abortRef = useRef<AbortController | null>(null);
  // Only decides whether a limit message also offers an account. The server still decides the limit.
  const { data: session } = authClient.useSession();

  const [step, setStep] = useState<TryOnStep>("photo");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ageState, setAgeState] = useState<TryOnAgeState | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<TryOnFailureReason | null>(null);
  const [result, setResult] = useState<TryOnResult | null>(null);

  // Object URLs are revoked when replaced and on unmount, so no image outlives its use.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const locked = phase === "loading";
  const canGenerate =
    !locked &&
    file !== null &&
    fileError === null &&
    acknowledged &&
    isTryOnAgeAllowed(ageState);

  function clearFileInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep("photo");
    setFile(null);
    setPreviewUrl(null);
    setFileError(null);
    setAcknowledged(false);
    setAgeState(null);
    setPhase("idle");
    setErrorMessage(null);
    setErrorReason(null);
    setResult(null);
    clearFileInput();
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    if (locked || abortRef.current !== null) return;
    const next = event.target.files?.[0] ?? null;
    setResult(null);
    setErrorMessage(null);
    setErrorReason(null);
    setPhase("idle");
    if (next === null) {
      setFile(null);
      setPreviewUrl(null);
      setFileError(null);
      return;
    }
    const problem = validateTryOnFile(next);
    setFileError(problem);
    if (problem !== null) {
      setFile(null);
      setPreviewUrl(null);
      clearFileInput();
      return;
    }
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
  }

  const canContinue = !locked && file !== null && fileError === null;

  function continueToConfirm() {
    if (!canContinue) return;
    setStep((current) => nextTryOnStep(current, "continue"));
  }

  /** Back to choosing a photo. The current one stays until another replaces it. */
  function changePhoto() {
    if (locked || abortRef.current !== null) return;
    setResult(null);
    setErrorMessage(null);
    setErrorReason(null);
    setPhase("idle");
    setStep((current) => nextTryOnStep(current, "change-photo"));
  }

  /** Back to the confirmation step to run again; the acknowledgement is asked afresh. */
  function backToConfirm() {
    if (locked || abortRef.current !== null) return;
    setResult(null);
    setErrorMessage(null);
    setErrorReason(null);
    setPhase("idle");
    setStep((current) => nextTryOnStep(current, "back"));
  }

  async function generate() {
    // `abortRef` is set synchronously, so a second click in the same frame cannot start a second
    // generation before `phase` has re-rendered.
    if (!canGenerate || file === null || ageState === null || abortRef.current !== null) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStep((current) => nextTryOnStep(current, "generate"));
    setPhase("loading");
    setErrorMessage(null);
    setErrorReason(null);
    setResult(null);

    const body = new FormData();
    body.append("photo", file);
    body.append("productSlug", productSlug);
    body.append("likenessAcknowledged", "true");
    body.append("ageState", ageState);

    try {
      const response = await fetch("/api/try-on", { method: "POST", body, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};

      if (
        response.ok &&
        record.ok === true &&
        typeof record.imageBase64 === "string" &&
        (record.mimeType === "image/png" || record.mimeType === "image/jpeg")
      ) {
        setResult(decodeImage(record.imageBase64, record.mimeType));
        setPhase("success");
      } else {
        setErrorMessage(tryOnFailureMessage(record.reason));
        setErrorReason(parseTryOnFailureReason(record.reason));
        setPhase("error");
        if (isFinalForPhoto(record.reason)) {
          // The provider refused this photo for good. It is dropped, and the shopper is sent back to
          // choose another, with the explanation still showing there.
          setFile(null);
          setPreviewUrl(null);
          clearFileInput();
          setStep((current) => nextTryOnStep(current, "photo-dropped"));
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorMessage(
        error instanceof TypeError ? TRY_ON_NETWORK_FAILURE_MESSAGE : tryOnFailureMessage(undefined),
      );
      setPhase("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // The acknowledgement is a representation about one photo for one generation. Asking again
      // for the next attempt is deliberate (spec §6), and the server demands it regardless.
      if (!controller.signal.aborted) setAcknowledged(false);
    }
  }

  function chooseAge(value: TryOnAgeState) {
    if (locked || abortRef.current !== null) return;
    setAgeState(value);
  }

  function chooseAcknowledged(value: boolean) {
    if (locked || abortRef.current !== null) return;
    setAcknowledged(value);
  }

  return {
    step,
    stepNumber: tryOnStepNumber(step),
    canContinue,
    continueToConfirm,
    changePhoto,
    backToConfirm,
    locked,
    fileName: file?.name ?? null,
    previewUrl,
    fileError,
    acknowledged,
    setAcknowledged: chooseAcknowledged,
    ageState,
    setAgeState: chooseAge,
    isTeen: isTeenAgeState(ageState),
    isBlockedAge: isBlockedAgeState(ageState),
    phase,
    errorMessage,
    errorReason,
    quotaUpsell: tryOnQuotaUpsell(errorReason, Boolean(session)),
    result,
    canGenerate,
    missingSteps: missingTryOnSteps({ hasPhoto: file !== null, ageState, acknowledged }),
    chooseFile,
    generate,
    reset,
  };
}
