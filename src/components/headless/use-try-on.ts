"use client";

import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";

import { createTryOnQuotaLoader } from "./try-on-quota.ts";
import {
  isBlockedAgeState,
  isTeenAgeState,
  isTryOnAgeAllowed,
  missingTryOnSteps,
  nextTryOnStep,
  tryOnBusyElsewhereMessage,
  tryOnLoginHref,
  tryOnQuotaLine,
  tryOnStepNumber,
  tryOnQuotaUpsell,
  validateTryOnFile,
  type TryOnAgeState,
  type TryOnQuotaView,
  type TryOnStep,
} from "./try-on-model.ts";
import { useTryOnSession, type TryOnJob } from "./try-on-session.tsx";

/**
 * Virtual try-on behaviour for a PDP dialog: the photo, the shopper's attestations, the steps, and
 * the one generation that `useTryOnSession` runs for them.
 *
 * Isolation is the design constraint. This hook shares no state with the variant selection or the
 * cart and imports neither, so a failure here cannot change what the shopper is buying. It holds the
 * photo only as an in-memory blob URL, revokes it when replaced, and `reset()` drops the form when
 * the dialog closes — nothing is written to browser storage.
 *
 * The dialog is a three-step wizard (`step`): photo, age and confirmation, result. Loading, success
 * and failure are all the result step, so the form is not on screen while a request is in flight.
 *
 * The request itself is not this hook's. `generate()` hands it to the session provider in the root
 * layout, which keeps it running when the dialog closes or the shopper moves to another page; the
 * phase, result and error shown here are that job's, when it is for this product. Reopening the
 * dialog (`resume()`) puts the shopper back on the job's result step, with its photo and age, so
 * "Tạo lại" still works. A job for another product that is still loading blocks a new one here:
 * the provider serves one at a time, and an attempt sent while it is busy is counted and refused.
 *
 * Everything the request is built from is frozen while it runs, in the hook and not only in the
 * markup. The setters below ignore changes while `locked`, whatever the markup does.
 *
 * It submits the photo, the product slug, the acknowledgement and the age state, and nothing else:
 * in particular no product image URL, because the server chooses the garment image itself.
 */

type Phase = "idle" | TryOnJob["status"];
export type { TryOnResult } from "./try-on-session.tsx";

export function useTryOn({
  productSlug,
  productName,
  fileInputRef,
  active,
}: Readonly<{
  productSlug: string;
  productName: string;
  /** The markup's own file input, so a refused photo can be cleared without remounting (and losing focus). */
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** Whether the dialog is open: the outcome of a job counts as seen only while it is on screen. */
  active: boolean;
}>) {
  const session = useTryOnSession();
  const job = session.job?.productSlug === productSlug ? session.job : null;
  const otherJob = session.job !== null && job === null ? session.job : null;

  const [step, setStep] = useState<TryOnStep>("photo");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ageState, setAgeState] = useState<TryOnAgeState | null>(null);
  // What is left today, as the server says. Display only: the server enforces the limit on its own.
  // `quotaCurrent` is false from the moment a refresh starts until it answers, so a number that may
  // be out of date is never shown; the audience it carries survives that wait (it only decides
  // whether an account is offered) but is dropped when a refresh fails or the dialog resets.
  const [quota, setQuota] = useState<TryOnQuotaView | null>(null);
  const [quotaCurrent, setQuotaCurrent] = useState(false);
  const quotaLoaderRef = useRef<ReturnType<typeof createTryOnQuotaLoader> | null>(null);
  quotaLoaderRef.current ??= createTryOnQuotaLoader(async (signal) => {
    const response = await fetch("/api/try-on", { method: "GET", cache: "no-store", signal });
    return response.json();
  });

  // Object URLs are revoked when replaced and on unmount, so no image outlives its use.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  useEffect(() => {
    const loader = quotaLoaderRef.current;
    return () => loader?.cancel();
  }, []);

  const phase: Phase = job?.status ?? "idle";
  const locked = phase === "loading";
  const busyElsewhere = otherJob?.status === "loading";
  const canGenerate =
    !locked &&
    !busyElsewhere &&
    file !== null &&
    fileError === null &&
    acknowledged &&
    isTryOnAgeAllowed(ageState);

  function clearFileInput() {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /** Asks the server what is left today. Only the latest answer is applied; a failure shows no number. */
  async function refreshQuota() {
    setQuotaCurrent(false);
    const outcome = await quotaLoaderRef.current!.load();
    if (outcome.kind === "superseded") return;
    setQuota(outcome.kind === "known" ? outcome.quota : null);
    setQuotaCurrent(outcome.kind === "known");
  }

  // When this product's job settles. The acknowledgement is a representation about one photo for one
  // generation; asking again for the next attempt is deliberate (spec §6), and the server demands it
  // regardless. Every submitted attempt counts, so the number has moved whatever the outcome was. A
  // photo the provider refused for good is dropped and the shopper sent back to choose another, with
  // the explanation still showing there.
  const settledKey = job !== null && job.status !== "loading" ? `${job.id}:${job.status}` : null;
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (settledKey === null || settledRef.current === settledKey || job === null) return;
    settledRef.current = settledKey;
    setAcknowledged(false);
    if (active) void refreshQuota();
    if (job.photoRefused) {
      setFile(null);
      setPreviewUrl(null);
      clearFileInput();
      setStep((current) => nextTryOnStep(current, "photo-dropped"));
    }
    // Only a newly settled job should run this; the rest is read as of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey]);

  // An outcome on screen has been seen: the dock and the tab title stop pointing to it.
  const { markSeen, discard } = session;
  const showing = active && job !== null && job.status !== "loading" && !job.seen && step !== "confirm";
  useEffect(() => {
    if (showing && job) markSeen(job.id);
  }, [showing, job, markSeen]);

  /** Drops this product's settled result or error, as replacing the photo or going back always did. */
  function dropSettledJob() {
    if (job !== null && job.status !== "loading") discard(job.id);
  }

  /**
   * Called when the dialog opens. With a job for this product the shopper lands on its result step
   * (or back on the photo step, if the photo was refused), with the job's photo and age restored.
   */
  function resume() {
    if (job === null) return;
    if (job.photoRefused) {
      setStep("photo");
      return;
    }
    setStep("result");
    if (file === null) {
      setFile(job.file);
      setPreviewUrl(URL.createObjectURL(job.file));
      setFileError(null);
    }
    if (ageState === null) setAgeState(job.ageState);
  }

  /**
   * Called when the dialog closes. The form is dropped; the job is not aborted — it keeps running
   * and the dock reports it — but an outcome the shopper has already seen goes with the dialog.
   */
  function reset() {
    quotaLoaderRef.current?.cancel();
    setQuota(null);
    setQuotaCurrent(false);
    setStep("photo");
    setFile(null);
    setPreviewUrl(null);
    setFileError(null);
    setAcknowledged(false);
    setAgeState(null);
    clearFileInput();
    if (job !== null && job.status !== "loading" && (job.seen || showing)) discard(job.id);
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    if (locked) return;
    const next = event.target.files?.[0] ?? null;
    dropSettledJob();
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
    if (locked) return;
    dropSettledJob();
    setStep((current) => nextTryOnStep(current, "change-photo"));
  }

  /** Back to the confirmation step to run again; the acknowledgement is asked afresh. */
  function backToConfirm() {
    if (locked) return;
    dropSettledJob();
    setStep((current) => nextTryOnStep(current, "back"));
  }

  function generate() {
    if (!canGenerate || file === null || ageState === null) return;
    // The session refuses synchronously while any job is loading, so a second click in the same
    // frame cannot start a second generation before this has re-rendered.
    if (!session.start({ productSlug, productName, file, ageState })) return;
    setStep((current) => nextTryOnStep(current, "generate"));
  }

  function chooseAge(value: TryOnAgeState) {
    if (locked) return;
    setAgeState(value);
  }

  function chooseAcknowledged(value: boolean) {
    if (locked) return;
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
    /** When this product's job started and the photo it was made from, for the waiting picture. */
    jobStartedAt: job?.startedAt ?? null,
    jobPhotoUrl: job?.photoUrl ?? null,
    errorMessage: job?.errorMessage ?? null,
    errorReason: job?.errorReason ?? null,
    /** Set while another product's try-on is being made: this one waits for it. */
    busyMessage: busyElsewhere && otherJob ? tryOnBusyElsewhereMessage(otherJob.productName) : null,
    quota,
    quotaLine: quotaCurrent ? tryOnQuotaLine(quota) : null,
    quotaUpsell: tryOnQuotaUpsell(job?.errorReason ?? null, quota?.audience ?? null),
    loginHref: tryOnLoginHref(productSlug),
    refreshQuota,
    result: job?.result ?? null,
    canGenerate,
    missingSteps: missingTryOnSteps({ hasPhoto: file !== null, ageState, acknowledged }),
    chooseFile,
    generate,
    resume,
    reset,
  };
}
