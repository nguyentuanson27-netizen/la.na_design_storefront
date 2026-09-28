"use client";

import { useEffect, useRef } from "react";

import type { PurchaseEvent } from "@/tracking/commerce-events";

type Oaiq = (
  command: "measure",
  eventName: "order_created",
  data: Record<string, unknown>,
  options: { event_id: string },
) => void;

const POLL_INTERVAL_MS = 250;
const QUEUE_WAIT_MS = 30_000;

function readOaiq(): Oaiq | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { oaiq?: unknown }).oaiq;
  return typeof candidate === "function" ? (candidate as Oaiq) : null;
}

function buildPixelData(event: PurchaseEvent): Record<string, unknown> {
  return {
    type: "contents",
    amount: event.ecommerce.la_total_vnd,
    currency: "VND",
    contents: event.ecommerce.items.map((item) => ({
      id: item.item_id,
      name: item.item_name,
      content_type: "product",
      quantity: item.quantity,
      amount: item.price,
      currency: "VND",
    })),
  };
}

/**
 * Browser twin of the server-side order_created event.
 *
 * The immutable public order code is reused as event_id. If the SDK is late, wait for its queue
 * stub rather than losing the event; if it never appears, measurement quietly gives up.
 */
export function ChatGptAdsOrderEvent({ event }: { event: PurchaseEvent }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const eventId = event.ecommerce.event_id;
    const data = buildPixelData(event);
    const send = () => {
      const oaiq = readOaiq();
      if (oaiq === null) return false;
      try {
        oaiq("measure", "order_created", data, { event_id: eventId });
        return true;
      } catch {
        return false;
      }
    };

    if (send()) return;

    const stopAt = Date.now() + QUEUE_WAIT_MS;
    const timer = window.setInterval(() => {
      if (send() || Date.now() >= stopAt) window.clearInterval(timer);
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [event]);

  return null;
}
