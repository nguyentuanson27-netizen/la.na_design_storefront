export type ReminderState = "unseen" | "open" | "seen";
export function reminderSubmitDecision(input: {state: ReminderState; valid: boolean; busy: boolean; needsReminder: boolean}): "block" | "remind" | "submit" {
  if (!input.valid || input.busy || input.state === "open") return "block";
  return input.state === "unseen" && input.needsReminder ? "remind" : "submit";
}
export function parseReminderAttempt(raw: string | null, key: string): boolean {
  if (!raw || raw.length > 256 || !/^[a-f0-9]{64}$/.test(key)) return false;
  try {
    const v = JSON.parse(raw);
    return v !== null && Object.keys(v).sort().join(",") === "key,seen,version" && v.version === 1 && v.key === key && v.seen === true;
  } catch { return false; }
}
