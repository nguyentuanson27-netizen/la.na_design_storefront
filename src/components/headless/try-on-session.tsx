"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { compressTryOnPhoto } from "./try-on-photo.ts";
import {
  TRY_ON_DONE_TITLE_PREFIX,
  TRY_ON_NETWORK_FAILURE_MESSAGE,
  isFinalForPhoto,
  parseTryOnFailureReason,
  tryOnFailureMessage,
  type TryOnAgeState,
  type TryOnFailureReason,
} from "./try-on-model.ts";

/**
 * The one try-on generation in flight, held above the page so it outlives the dialog that started it.
 *
 * A generation takes about a minute. Before this, closing the dialog aborted the request: the shopper
 * lost the picture and still spent the attempt, because the server counts it on arrival and the
 * worker finishes it regardless. Now the request belongs to this provider, which the root layout
 * mounts once. The dialog can close, and the shopper can move to another page in the app, while it
 * runs; `BrandTryOnDock` shows its progress and says when it is ready.
 *
 * One job at a time, for the whole site, because the provider serves one at a time (a Flow profile
 * drives one Chrome generation) and an attempt sent while it is busy is refused as BUSY *after* it
 * has been counted. `start` refuses a second job while one is loading; the dialog says why.
 *
 * Privacy is unchanged: everything is in memory as blob URLs, revoked when the job is replaced or
 * discarded; nothing is written to browser storage. A result the shopper has seen is discarded when
 * they close what showed it, as closing the dialog always did; only a result they have not seen yet
 * waits for them, and the dock offers to discard it.
 */

export type TryOnResult = Readonly<{ url: string; mimeType: "image/png" | "image/jpeg" }>;

export type TryOnJob = Readonly<{
  id: number;
  productSlug: string;
  productName: string;
  /**
   * The photo as chosen, so the dialog can offer "Tạo lại" with it after being closed and reopened.
   * `null` once the provider has refused the photo: it is released then, with its URL.
   */
  file: File | null;
  ageState: TryOnAgeState;
  /** This job's own object URL for the photo (the dialog's preview URL dies with the dialog). */
  photoUrl: string | null;
  startedAt: number;
  status: "loading" | "success" | "error";
  result: TryOnResult | null;
  errorMessage: string | null;
  errorReason: TryOnFailureReason | null;
  /** The provider refused this photo for good: the shopper must choose another. */
  photoRefused: boolean;
  /** Whether the outcome has been on screen; until then the dock and the tab title point to it. */
  seen: boolean;
}>;

export type TryOnJobInput = Readonly<{
  productSlug: string;
  productName: string;
  file: File;
  ageState: TryOnAgeState;
}>;

/** Opens the place that shows a job: a PDP registers its own dialog, the dock falls back to a viewer. */
type JobOpener = (opener: HTMLElement | null) => void;

export type TryOnSession = Readonly<{
  job: TryOnJob | null;
  /**
   * False, and nothing is sent, while another job is loading. `onSettled` is called once with the
   * settled job, from the request's own callback rather than a render, so the form that started it
   * can reset itself (a component that has unmounted meanwhile simply ignores it).
   */
  start: (input: TryOnJobInput, onSettled?: (job: TryOnJob) => void) => boolean;
  /** Drops a settled job and its images. A loading job is never dropped: its attempt is spent. */
  discard: (id: number) => void;
  markSeen: (id: number) => void;
  /** A PDP's dialog, for its own product. Returns the unregister function. */
  registerDialog: (productSlug: string, open: JobOpener) => () => void;
  /** Shows the current job where it belongs: its product's dialog when that page is open, else `fallback`. */
  openJob: (opener: HTMLElement | null, fallback: JobOpener) => void;
}>;

const TryOnSessionContext = createContext<TryOnSession | null>(null);

export function useTryOnSession(): TryOnSession {
  const session = useContext(TryOnSessionContext);
  if (session === null) throw new Error("useTryOnSession needs a TryOnSessionProvider above it");
  return session;
}

function decodeImage(base64: string, mimeType: TryOnResult["mimeType"]): TryOnResult {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { url: URL.createObjectURL(new Blob([bytes], { type: mimeType })), mimeType };
}

function revokeJob(job: TryOnJob) {
  if (job.photoUrl) URL.revokeObjectURL(job.photoUrl);
  if (job.result) URL.revokeObjectURL(job.result.url);
}

type Outcome = Pick<TryOnJob, "status" | "result" | "errorMessage" | "errorReason" | "photoRefused">;

async function runJob(input: TryOnJobInput): Promise<Outcome> {
  // Shrunk first (a few hundred ms) so the upload and the model input are small; the original is
  // sent as is if the browser cannot do it.
  const photo = await compressTryOnPhoto(input.file);
  const body = new FormData();
  body.append("photo", photo);
  body.append("productSlug", input.productSlug);
  body.append("likenessAcknowledged", "true");
  body.append("ageState", input.ageState);

  try {
    const response = await fetch("/api/try-on", { method: "POST", body });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (
      response.ok &&
      record.ok === true &&
      typeof record.imageBase64 === "string" &&
      (record.mimeType === "image/png" || record.mimeType === "image/jpeg")
    ) {
      return {
        status: "success",
        result: decodeImage(record.imageBase64, record.mimeType),
        errorMessage: null,
        errorReason: null,
        photoRefused: false,
      };
    }
    return {
      status: "error",
      result: null,
      errorMessage: tryOnFailureMessage(record.reason),
      errorReason: parseTryOnFailureReason(record.reason),
      photoRefused: isFinalForPhoto(record.reason),
    };
  } catch (error) {
    return {
      status: "error",
      result: null,
      errorMessage: error instanceof TypeError ? TRY_ON_NETWORK_FAILURE_MESSAGE : tryOnFailureMessage(undefined),
      errorReason: null,
      photoRefused: false,
    };
  }
}

/**
 * Tells a shopper who went to another tab or app that the picture is ready: the tab title gains a
 * mark until they come back. A shopper still on the page gets a short vibration where the device
 * supports it (not iOS); the dock shows the rest.
 */
function useReadyNotice(job: TryOnJob | null) {
  const notifiedRef = useRef<number | null>(null);

  useEffect(() => {
    if (job === null || job.status === "loading" || job.seen || notifiedRef.current === job.id) return;
    notifiedRef.current = job.id;

    if (document.visibilityState === "visible") {
      if (job.status === "success") navigator.vibrate?.(120);
      return;
    }
    const original = document.title;
    const marked = `${TRY_ON_DONE_TITLE_PREFIX}${original}`;
    document.title = marked;
    function restore() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", restore);
      // A navigation may have set its own title meanwhile; only the mark this put there is undone.
      if (document.title === marked) document.title = original;
    }
    document.addEventListener("visibilitychange", restore);
    return () => {
      document.removeEventListener("visibilitychange", restore);
      if (document.title === marked) document.title = original;
    };
  }, [job]);
}

export function TryOnSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [job, setJob] = useState<TryOnJob | null>(null);
  // The same job, readable synchronously: two clicks in one frame must not start two jobs.
  const jobRef = useRef<TryOnJob | null>(null);
  const nextIdRef = useRef(1);
  const dialogsRef = useRef(new Map<string, JobOpener>());

  const commit = useCallback((next: TryOnJob | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  const start = useCallback(
    (input: TryOnJobInput, onSettled?: (job: TryOnJob) => void) => {
      const current = jobRef.current;
      if (current?.status === "loading") return false;
      if (current) revokeJob(current);

      const id = nextIdRef.current++;
      commit({
        id,
        productSlug: input.productSlug,
        productName: input.productName,
        file: input.file,
        ageState: input.ageState,
        photoUrl: URL.createObjectURL(input.file),
        startedAt: Date.now(),
        status: "loading",
        result: null,
        errorMessage: null,
        errorReason: null,
        photoRefused: false,
        seen: false,
      });

      void runJob(input).then((outcome) => {
        const latest = jobRef.current;
        // Discarded or replaced meanwhile cannot happen while loading, but a stale answer is dropped.
        if (latest === null || latest.id !== id) {
          if (outcome.result) URL.revokeObjectURL(outcome.result.url);
          return;
        }
        let settled: TryOnJob = { ...latest, ...outcome };
        if (outcome.photoRefused) {
          // A photo the provider refused for good is not kept, shown or offered again anywhere.
          if (latest.photoUrl) URL.revokeObjectURL(latest.photoUrl);
          settled = { ...settled, file: null, photoUrl: null };
        }
        commit(settled);
        onSettled?.(settled);
      });
      return true;
    },
    [commit],
  );

  const discard = useCallback(
    (id: number) => {
      const current = jobRef.current;
      if (current === null || current.id !== id || current.status === "loading") return;
      revokeJob(current);
      commit(null);
    },
    [commit],
  );

  const markSeen = useCallback(
    (id: number) => {
      const current = jobRef.current;
      if (current === null || current.id !== id || current.status === "loading" || current.seen) return;
      commit({ ...current, seen: true });
    },
    [commit],
  );

  const registerDialog = useCallback((productSlug: string, open: JobOpener) => {
    dialogsRef.current.set(productSlug, open);
    return () => {
      if (dialogsRef.current.get(productSlug) === open) dialogsRef.current.delete(productSlug);
    };
  }, []);

  const openJob = useCallback((opener: HTMLElement | null, fallback: JobOpener) => {
    const current = jobRef.current;
    if (current === null) return;
    (dialogsRef.current.get(current.productSlug) ?? fallback)(opener);
  }, []);

  // The provider lives as long as the tab; this only runs on a full teardown.
  useEffect(() => () => {
    if (jobRef.current) revokeJob(jobRef.current);
  }, []);

  useReadyNotice(job);

  const session = useMemo<TryOnSession>(
    () => ({ job, start, discard, markSeen, registerDialog, openJob }),
    [job, start, discard, markSeen, registerDialog, openJob],
  );

  return <TryOnSessionContext.Provider value={session}>{children}</TryOnSessionContext.Provider>;
}
