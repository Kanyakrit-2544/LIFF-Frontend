import { env } from "../env";

function secretMap(): Record<string, string> {
  const raw = env("partner").PARTNER_HMAC_SECRETS_JSON;
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([id, secret]) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof secret === "string" && secret.length >= 32)
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

export function partnerSecretFor(partnerId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(partnerId)) return null;
  return secretMap()[partnerId] ?? null;
}

export function partnerLineChannelId(): string {
  return env("partner").PARTNER_LINE_CHANNEL_ID ?? env("line").LINE_CHANNEL_ID;
}

