import type { CustomerDoc, RecordStatus } from "../db/models";
import { maskEmail, maskPhone } from "../security/pii";
import { emailHash, nameKeys, personToken, phoneHash } from "./tokens";

const date = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const iso = (v: Date | null | undefined) => (v ? v.toISOString() : null);

export interface ScrubbedCustomer {
  _id: string;
  status: RecordStatus;
  mergedInto: string | null;
  title: string | null;
  heardFrom: string | null;
  displayName: string | null;
  nickname: string | null;
  fullNameEn: string | null;
  phone: string | null;
  email: string | null;
  phoneHash: string | null;
  emailHash: string | null;
  nameKeys: string[];
  nicknameKey: string | null;
  birthYear: number | null;
  province: string | null;
  customerStatus: CustomerDoc["customerStatus"];
  tags: string[];
  sources: string[];
  consentMarketing: boolean;
  firstInteractionAt: string | null;
  firstMessageAt: string | null;
  formSubmittedAt: string | null;
  /**
   * ที่มาจากโฆษณา (docs/28) — ส่งเฉพาะที่ analytics ใช้จริง
   * ไม่ส่ง pageId/formId/adId เพราะเป็น id ของแพลตฟอร์ม ไม่จำเป็นต่อการวิเคราะห์
   */
  leadAttribution: {
    courseCode: string | null;
    campaignName: string | null;
    adOrOrganic: "ad" | "organic" | "unknown";
    attributionPending: boolean;
  } | null;
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
    title: c.title ?? null,
    heardFrom: c.heardFrom ?? null,
    displayName: personToken(c.displayName),
    nickname: personToken(c.nickname),
    fullNameEn: personToken(c.fullNameEn),
    phone: phone ? maskPhone(phone) : null,
    email: email ? maskEmail(email) : null,
    phoneHash: phoneHash(phone),
    emailHash: emailHash(email),
    nameKeys: nameKeys(c.displayName, c.fullNameEn),
    nicknameKey: nameKeys(c.nickname)[0] ?? null,
    birthYear: c.birthYear ?? null,
    province: null,
    customerStatus: c.customerStatus,
    tags: c.tags ?? [],
    sources: c.sources ?? [],
    consentMarketing: c.consent?.marketing === true,
    firstInteractionAt: date(c.firstInteractionAt),
    firstMessageAt: date(c.firstMessageAt ?? null),
    formSubmittedAt: date(c.profileRef?.updatedAt ?? null),
    leadAttribution: c.leadAttribution
      ? {
          courseCode: c.leadAttribution.courseCode,
          campaignName: c.leadAttribution.campaignName,
          adOrOrganic: c.leadAttribution.adOrOrganic,
          attributionPending: c.leadAttribution.attributionPending,
        }
      : null,
    syncedAt: now.toISOString(),
    sourceUpdatedAt: iso(c.updatedAt),
  };
}
