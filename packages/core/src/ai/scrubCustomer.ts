import type { CustomerDoc, RecordStatus } from "../db/models";
import { maskEmail, maskPhone, hashValue } from "../security/pii";

const date = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const iso = (v: Date | null | undefined) => (v ? v.toISOString() : null);

function personToken(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return `<PERSON_${hashValue(`PERSON|${normalized.toLocaleLowerCase("th-TH")}`).slice(0, 8)}>`;
}

export interface ScrubbedCustomer {
  _id: string;
  status: RecordStatus;
  mergedInto: string | null;
  displayName: string | null;
  nickname: string | null;
  fullNameEn: string | null;
  phone: string | null;
  email: string | null;
  phoneHash: string | null;
  emailHash: string | null;
  birthYear: number | null;
  province: string | null;
  customerStatus: CustomerDoc["customerStatus"];
  tags: string[];
  sources: string[];
  consentMarketing: boolean;
  firstInteractionAt: string | null;
  firstMessageAt: string | null;
  formSubmittedAt: string | null;
  syncedAt: string;
  sourceUpdatedAt: string | null;
}

export function scrubCustomer(c: CustomerDoc, now = new Date()): ScrubbedCustomer {
  const phone = c.phone ?? null;
  const email = c.email ?? null;

  return {
    _id: c._id,
    status: c.status,
    mergedInto: c.mergedInto ?? null,
    displayName: personToken(c.displayName),
    nickname: personToken(c.nickname),
    fullNameEn: personToken(c.fullNameEn),
    phone: phone ? maskPhone(phone) : null,
    email: email ? maskEmail(email) : null,
    phoneHash: phone ? hashValue(`PHONE|${phone}`) : null,
    emailHash: email ? hashValue(`EMAIL|${email.toLowerCase()}`) : null,
    birthYear: c.birthYear ?? null,
    province: null,
    customerStatus: c.customerStatus,
    tags: c.tags ?? [],
    sources: c.sources ?? [],
    consentMarketing: c.consent?.marketing === true,
    firstInteractionAt: date(c.firstInteractionAt),
    firstMessageAt: date(c.firstMessageAt ?? null),
    formSubmittedAt: date(c.profileRef?.updatedAt ?? null),
    syncedAt: now.toISOString(),
    sourceUpdatedAt: iso(c.updatedAt),
  };
}
