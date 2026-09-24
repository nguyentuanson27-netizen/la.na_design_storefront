"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { submitContactForm } from "@/routes/contact-action";

type ContactResult = Awaited<ReturnType<typeof submitContactForm>>;
type InvalidField = Extract<
  ContactResult,
  { ok: false; reason: "INVALID_INPUT" }
>["field"];
type FieldName = Exclude<InvalidField, "form">;

type FormStatus =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "success"; message: string }>
  | Readonly<{ kind: "error"; message: string; field: InvalidField }>;

const FIELD_CLASS =
  "mt-2 w-full border border-black/45 bg-transparent px-4 py-3 text-base outline-none transition focus:border-black focus-visible:outline-2 focus-visible:outline-offset-2";

function validationMessage(field: InvalidField): string {
  if (field === "name") return "Họ tên phải có từ 1 đến 100 ký tự.";
  if (field === "email") return "Email không hợp lệ hoặc vượt quá 254 ký tự.";
  if (field === "message") return "Nội dung phải có từ 1 đến 4.000 ký tự.";
  return "Vui lòng kiểm tra họ tên, email và nội dung trước khi gửi.";
}

function messageForResult(result: ContactResult): FormStatus {
  if (result.ok) {
    return {
      kind: "success",
      message: "Tin nhắn đã được gửi. Đội ngũ hỗ trợ sẽ phản hồi trong giờ hỗ trợ.",
    };
  }

  if (result.reason === "INVALID_INPUT") {
    return {
      kind: "error",
      field: result.field,
      message: validationMessage(result.field),
    };
  }

  if (result.reason === "RATE_LIMITED") {
    return {
      kind: "error",
      field: "form",
      message: "Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
    };
  }

  return {
    kind: "error",
    field: "form",
    message: "Chưa thể gửi tin nhắn lúc này. Vui lòng dùng một trong các kênh liên hệ chính thức bên dưới.",
  };
}

export function ContactForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });

  useEffect(() => {
    if (status.kind !== "error" || status.field === "form") return;

    const control = formRef.current?.elements.namedItem(status.field);
    if (control instanceof HTMLElement) control.focus();
  }, [status]);

  function fieldError(field: FieldName): string | null {
    return status.kind === "error" && status.field === field ? status.message : null;
  }

  const nameError = fieldError("name");
  const emailError = fieldError("email");
  const messageError = fieldError("message");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = {
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      message: String(formData.get("message") ?? ""),
    };

    setPending(true);
    setStatus({ kind: "idle" });

    try {
      const result = await submitContactForm(payload);
      const nextStatus = messageForResult(result);
      setStatus(nextStatus);
      if (nextStatus.kind === "success") formRef.current?.reset();
    } catch {
      setStatus({
        kind: "error",
        field: "form",
        message: "Chưa thể gửi tin nhắn lúc này. Vui lòng dùng một trong các kênh liên hệ chính thức bên dưới.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-12 max-w-2xl border-t border-black/15 pt-10" aria-labelledby="contact-form-heading">
      <h2 id="contact-form-heading" className="font-display text-3xl tracking-[-0.03em]">
        Gửi tin nhắn
      </h2>
      <p className="mt-3 text-sm leading-6 text-black/65">
        Điền họ tên, email và nội dung cần hỗ trợ.
      </p>

      <form ref={formRef} className="mt-7 grid gap-6" onSubmit={handleSubmit}>
        <label className="block text-sm font-medium" htmlFor="contact-name">
          Họ tên
          <input
            className={FIELD_CLASS}
            id="contact-name"
            name="name"
            aria-describedby={nameError ? "contact-name-error" : undefined}
            aria-invalid={nameError ? true : undefined}
            autoComplete="name"
            required
            type="text"
          />
          {nameError ? (
            <span id="contact-name-error" className="mt-2 block text-sm leading-6" role="alert">
              {nameError}
            </span>
          ) : null}
        </label>

        <label className="block text-sm font-medium" htmlFor="contact-email">
          Email
          <input
            className={FIELD_CLASS}
            id="contact-email"
            name="email"
            aria-describedby={emailError ? "contact-email-error" : undefined}
            aria-invalid={emailError ? true : undefined}
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
            type="email"
          />
          {emailError ? (
            <span id="contact-email-error" className="mt-2 block text-sm leading-6" role="alert">
              {emailError}
            </span>
          ) : null}
        </label>

        <label className="block text-sm font-medium" htmlFor="contact-message">
          Nội dung
          <textarea
            className={`${FIELD_CLASS} min-h-40 resize-y`}
            id="contact-message"
            name="message"
            aria-describedby={messageError ? "contact-message-error" : undefined}
            aria-invalid={messageError ? true : undefined}
            required
            rows={6}
          />
          {messageError ? (
            <span id="contact-message-error" className="mt-2 block text-sm leading-6" role="alert">
              {messageError}
            </span>
          ) : null}
        </label>

        <div>
          <button
            className="min-h-11 border border-black px-6 py-3 text-sm font-semibold transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={pending}
            type="submit"
          >
            {pending ? "Đang gửi…" : "Gửi tin nhắn"}
          </button>
        </div>

        {status.kind === "success" || (status.kind === "error" && status.field === "form") ? (
          <p
            className="text-sm leading-6"
            role={status.kind === "error" ? "alert" : "status"}
            aria-live={status.kind === "error" ? "assertive" : "polite"}
          >
            {status.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
