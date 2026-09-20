export type ContactDeliveryConfig = Readonly<{
  resendApiKey: string;
}>;

type ContactDeliveryEnvironment = Readonly<Record<string, string | undefined>>;

export class ContactDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactDeliveryConfigError";
  }
}

export function readContactDeliveryConfig(
  env: ContactDeliveryEnvironment = process.env,
): ContactDeliveryConfig {
  const resendApiKey = env.RESEND_API_KEY?.trim();
  if (!resendApiKey || /^REPLACE_ME(?:_|$)/i.test(resendApiKey)) {
    throw new ContactDeliveryConfigError("RESEND_API_KEY must be configured on the server");
  }

  return { resendApiKey };
}
