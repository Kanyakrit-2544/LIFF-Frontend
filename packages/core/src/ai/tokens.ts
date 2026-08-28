import { hashValue } from "../security/pii";
import { normalizeName } from "../identity/normalize";

/** Tokenize a person label without sending the original value to the AI mirror. */
export function personToken(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return `<PERSON_${hashValue(`PERSON|${normalized.toLocaleLowerCase("th-TH")}`).slice(0, 8)}>`;
}

/** Input must already be normalized to Thai E.164 by normalizePhone(). */
export function phoneHash(e164: string | null | undefined): string | null {
  return e164 ? hashValue(`PHONE|${e164}`) : null;
}

/** Email is lowercased before hashing so casing cannot split one identity. */
export function emailHash(email: string | null | undefined): string | null {
  return email ? hashValue(`EMAIL|${email.toLowerCase()}`) : null;
}

/** D26: only realistic ages are grouped into ten-year bands. */
export function ageBand(age: number | null | undefined): string | null {
  if (age === null || age === undefined || !Number.isInteger(age) || age < 10 || age >= 120) return null;
  const start = Math.floor(age / 10) * 10;
  return `${start}-${start + 9}`;
}

/** D27: preserve shared-slip grouping without exposing the slip number. */
export function slipGroupId(slipNo: string | null | undefined): string | null {
  const normalized = slipNo?.trim().toUpperCase();
  if (!normalized) return null;
  return hashValue(`SLIP|${normalized}`).slice(0, 12);
}

/** D28: hash name parts so matching can compare overlap without exposing names. */
export function nameKeys(...values: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const normalized = normalizeName(value)?.toLocaleLowerCase("th-TH");
    if (!normalized) continue;
    for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (word.length < 2) continue;
      keys.add(hashValue(`NAMEPART|${word}`).slice(0, 12));
    }
  }
  return [...keys].sort();
}
