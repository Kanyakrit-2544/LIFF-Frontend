import { maskEmail, maskPhone } from "../security/pii";
import { ageBand, emailHash, nameKeys, personToken, phoneHash, slipGroupId } from "./tokens";
import type { LegacyEnrollmentDoc, LegacyPaymentDoc, LegacyPersonDoc } from "../legacy/models";

const date = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

const SAFE_TH = [
  "หนังสือ", "ห้องพัก", "พักเดี่ยว", "คืนเงิน", "ค่าปรับ", "ย้ายเรียน", "ย้ายไป",
  "เพิ่ม", "เลื่อน", "ตัดสิทธิ", "ผ้าคลุม", "เรียนแทน", "ปรับ", "เปลี่ยนเป็น", "สิทธิ", "คน",
];

/** Remove known business words, then reject any remaining Thai text as possible PII. */
export function safeSessionLabel(label: string | null): string | null {
  if (label === null || label.trim() === "") return null;
  let rest = label;
  for (const word of SAFE_TH) rest = rest.split(word).join("");
  return /[\u0E00-\u0E7F]/.test(rest) ? "«ข้อความอื่น»" : label;
}

export interface ScrubbedLegacyPerson {
  _id: string;
  fullNameTh: string | null;
  fullNameEn: string | null;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  phoneHash: string | null;
  emailHash: string | null;
  nameKeys: string[];
  nicknameKey: string | null;
  ageBand: string | null;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  totalPaid: number;
  paymentCount: number;
  seatCount: number;
  courseCodes: string[];
  yearsActive: number[];
  synthetic: boolean;
  syncedAt: string;
  sourceUpdatedAt: string | null;
}

export interface ScrubbedLegacyPayment {
  _id: string;
  personId: string;
  slipGroupId: string | null;
  slipShared: boolean;
  amount: number | null;
  paidAt: string | null;
  year: number;
  month: number | null;
  saleRep: string | null;
  synthetic: boolean;
  syncedAt: string;
}

export interface ScrubbedLegacyEnrollment {
  _id: string;
  personId: string;
  paymentId: string;
  courseCode: string;
  kind: LegacyEnrollmentDoc["kind"];
  countsAsSeat: boolean;
  sessionLabel: string | null;
  sessionStart: string | null;
  sessionYear: number | null;
  sessionPrecision: LegacyEnrollmentDoc["sessionPrecision"];
  substitute: boolean;
  synthetic: boolean;
  syncedAt: string;
}

export function scrubLegacyPerson(
  person: LegacyPersonDoc,
  payments: readonly LegacyPaymentDoc[] = [],
  now = new Date()
): ScrubbedLegacyPerson {
  const yearsActive = [...new Set(payments.map((payment) => payment.year))].sort((a, b) => a - b);
  return {
    _id: person._id,
    fullNameTh: personToken(person.fullNameTh),
    fullNameEn: personToken(person.fullNameEn),
    nickname: personToken(person.nickname),
    phone: person.phone ? maskPhone(person.phone) : null,
    email: person.email ? maskEmail(person.email) : null,
    phoneHash: phoneHash(person.phone),
    emailHash: emailHash(person.email),
    nameKeys: nameKeys(person.fullNameTh, person.fullNameEn),
    nicknameKey: nameKeys(person.nickname)[0] ?? null,
    ageBand: ageBand(person.ageAtImport),
    firstPaidAt: date(person.firstPaidAt),
    lastPaidAt: date(person.lastPaidAt),
    totalPaid: person.totalPaid,
    paymentCount: person.paymentCount,
    seatCount: person.seatCount,
    courseCodes: [...person.courseCodes],
    yearsActive,
    synthetic: person.synthetic,
    syncedAt: now.toISOString(),
    sourceUpdatedAt: person.updatedAt.toISOString(),
  };
}

export function scrubLegacyPayment(payment: LegacyPaymentDoc, now = new Date()): ScrubbedLegacyPayment {
  return {
    _id: payment._id,
    personId: payment.personId,
    slipGroupId: slipGroupId(payment.slipNo),
    slipShared: payment.slipShared,
    amount: payment.amount,
    paidAt: date(payment.paidAt),
    year: payment.year,
    month: payment.paidAt ? payment.paidAt.getUTCMonth() + 1 : null,
    saleRep: payment.saleRep,
    synthetic: payment.synthetic,
    syncedAt: now.toISOString(),
  };
}

export function scrubLegacyEnrollment(
  enrollment: LegacyEnrollmentDoc,
  now = new Date()
): ScrubbedLegacyEnrollment {
  return {
    _id: enrollment._id,
    personId: enrollment.personId,
    paymentId: enrollment.paymentId,
    courseCode: enrollment.courseCode,
    kind: enrollment.kind,
    countsAsSeat: enrollment.countsAsSeat,
    sessionLabel: safeSessionLabel(enrollment.sessionLabel),
    sessionStart: date(enrollment.sessionStart),
    sessionYear: enrollment.sessionYear,
    sessionPrecision: enrollment.sessionPrecision,
    substitute: enrollment.substitute,
    synthetic: enrollment.synthetic,
    syncedAt: now.toISOString(),
  };
}
