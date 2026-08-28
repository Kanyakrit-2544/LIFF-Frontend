import type { EnrollmentKind } from "./courseCell";

/**
 * ฐาน legacy = ประวัติการซื้อคอร์สจากชีตขาย แยก database ออกจาก line_crm_dev
 * เพราะเป็นข้อมูลคนละสัญชาติ (ธุรกรรมย้อนหลัง ไม่มี consent ผ่าน LIFF) และเพื่อให้จำกัดสิทธิ์แยกได้
 *
 * แยก 3 collection โดยตั้งใจ:
 *   persons     — คน (dedupe แล้ว)
 *   payments    — 1 แถวในชีต = 1 การชำระ ถือ "เงิน" ไว้ที่นี่ที่เดียว
 *   enrollments — 1 คอร์สที่ติ๊กในแถวนั้น = 1 doc ถือ "ที่นั่ง" ไว้
 *
 * ⚠️ เหตุผลที่ห้ามยุบ payments กับ enrollments เข้าด้วยกัน:
 * หนึ่งแถวติ๊กได้หลายคอร์สแต่มียอดเงินก้อนเดียว (โปรไฟล์จริง: 15% ของแถวติ๊ก ≥2 คอร์ส)
 * ถ้าเอายอดไปแปะที่ระดับคอร์ส ยอดขายรวมจะเบิ้ลทันที
 */
export const LEGACY_COLLECTIONS = {
  persons: "legacy_persons",
  payments: "legacy_payments",
  enrollments: "legacy_enrollments",
  importRuns: "legacy_import_runs",
} as const;

export interface LegacySourceRef {
  sheet: string;
  /** เลขแถวจริงในไฟล์ (1-based ตามที่ Excel แสดง) — ไว้ย้อนไปดูต้นทาง */
  row: number;
}

export interface LegacyPersonDoc {
  _id: string; // lgp_<ULID>
  fullNameTh: string | null;
  fullNameEn: string | null;
  nickname: string | null;
  /** E.164 — normalize ด้วย normalizePhone ตัวเดียวกับฝั่ง LINE ไม่งั้น hash ไม่ตรงกัน */
  phone: string | null;
  email: string | null;
  /** ชีตรวม FB/Line/IG ไว้ช่องเดียว แยกไม่ได้ตั้งแต่ต้นทาง */
  socialHandle: string | null;
  ageAtImport: number | null;

  firstPaidAt: Date | null;
  lastPaidAt: Date | null;
  /** ยอดรวมจาก payments เท่านั้น — ห้ามบวกจาก enrollments */
  totalPaid: number;
  paymentCount: number;
  seatCount: number;
  courseCodes: string[];

  sourceRefs: LegacySourceRef[];
  /** true = ข้อมูลปั้น ห้ามนำไปใช้ตัดสินใจทางธุรกิจ */
  synthetic: boolean;
  importRunId: string;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface LegacyPaymentDoc {
  _id: string; // lgy_<ULID>
  personId: string;
  slipNo: string | null;
  /** จำนวนแถวที่ใช้เลขสลิปเดียวกัน — >1 แปลว่าจ่ายรวมกันมา ยอดอาจซ้อนกัน */
  slipShared: boolean;
  amount: number | null;
  paidAt: Date | null;
  year: number;
  saleRep: string | null;
  source: LegacySourceRef;
  synthetic: boolean;
  importRunId: string;
  createdAt: Date;
  schemaVersion: number;
}

export interface LegacyEnrollmentDoc {
  _id: string; // lge_<ULID>
  personId: string;
  paymentId: string;
  courseCode: string;
  /** ชื่อคอลัมน์ตามที่เขียนในชีต — เก็บไว้ตรวจย้อนว่า mapping ถูกไหม */
  courseLabel: string;
  kind: EnrollmentKind;
  /** false = relearn / waitlist / คืนเงิน / สินค้า — ห้ามนับเป็นที่นั่งที่ขายได้ */
  countsAsSeat: boolean;
  sessionLabel: string | null;
  sessionStart: Date | null;
  sessionPrecision: "day" | "month" | "none";
  sessionYear: number | null;
  refSlip: string | null;
  substitute: boolean;
  /** ข้อความดิบในเซลล์ — อาจมีชื่อคนจริง ห้ามออกจากฐานนี้โดยไม่ scrub */
  raw: string;
  source: LegacySourceRef;
  synthetic: boolean;
  importRunId: string;
  createdAt: Date;
  schemaVersion: number;
}

export interface LegacyImportRunDoc {
  _id: string; // job_<ULID>
  mode: "synthetic" | "real";
  sheets: string[];
  startedAt: Date;
  finishedAt: Date | null;
  counts: { rows: number; persons: number; payments: number; enrollments: number; skipped: number };
  /** หัวคอลัมน์ที่ courses.ts ยังไม่รู้จัก — ต้องมีคนมาเติมพจนานุกรม */
  unknownCourseHeaders: string[];
  notes: string[];
}

export const LEGACY_SCHEMA_VERSION = 1;
