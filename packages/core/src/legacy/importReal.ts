import { newId } from "../ids";
import { normalizePhone } from "../identity/normalize";
import { courseByHeader } from "./courses";
import { parseCourseCell } from "./courseCell";
import { sheetYear } from "./profile";
import {
  LEGACY_SCHEMA_VERSION,
  type LegacyEnrollmentDoc,
  type LegacyPaymentDoc,
  type LegacyPersonDoc,
} from "./models";

/**
 * ETL ของจริง — แปลงแถวจากชีตขาย (Inner.xlsx) เป็น doc ฐาน legacy
 *
 * ทำไมแยกจาก generate.ts: generate ปั้น "รูปทรง" จากสถิติ (synthetic: true)
 * ตัวนี้อ่านของจริง (synthetic: false) — โครง doc ปลายทาง "ต้อง" เป็นตัวเดียวกันเป๊ะ
 * เพื่อให้ scrub / match / analytics ทำงานเหมือนกันไม่ว่าจะ synthetic หรือจริง
 *
 * หน้าที่ตรงนี้ = logic ล้วน (แถว → doc) ทดสอบได้โดยไม่แตะไฟล์/DB
 * การอ่าน xlsx และเขียน Mongo อยู่ที่ scripts/import-legacy.ts (ชั้น IO)
 *
 * ⚠️ ข้อมูลจริงมี PII และไม่ได้ผ่าน consent ผ่าน LIFF — ห้าม commit ผลลัพธ์ลง repo
 *    `raw` / ชื่อ / เบอร์ อาจมีชื่อคนจริง ต้อง scrub ก่อนออกจากฐานนี้ (ดู scrubLegacy.ts)
 */

/** field กลางที่ ETL รู้จัก — ตรงกับ FIELD_HEADERS ใน profile_xlsx.py */
export type LegacyField =
  | "no"
  | "paidAt"
  | "expiresAt"
  | "slipNo"
  | "fullNameTh"
  | "fullNameEn"
  | "nickname"
  | "age"
  | "phone"
  | "social"
  | "email"
  | "amount"
  | "saleRep"
  | "note"
  | "receipt";

/** 1 แถวข้อมูลดิบ หลังชั้น IO แกะคอลัมน์ให้แล้ว (ยังไม่ตีความค่า) */
export interface LegacyRawRow {
  /** เลขแถวจริงในไฟล์ (1-based ตามที่ Excel แสดง) */
  rowNumber: number;
  fields: Partial<Record<LegacyField, unknown>>;
  /** ช่องคอร์ส: label = หัวคอลัมน์ตามชีต, value = ค่าดิบในเซลล์ */
  courses: { label: string; value: unknown }[];
}

export interface ImportLegacySheetInput {
  /** ชื่อชีต — ต้องมีปีอยู่ในชื่อ (เช่น "Inner2025") ไว้ให้ sheetYear แกะ */
  sheet: string;
  rows: LegacyRawRow[];
}

export interface ImportLegacyOptions {
  sheets: ImportLegacySheetInput[];
  importRunId: string;
  now?: Date;
}

export interface ImportedLegacy {
  persons: LegacyPersonDoc[];
  payments: LegacyPaymentDoc[];
  enrollments: LegacyEnrollmentDoc[];
  /** หัวคอลัมน์คอร์สที่พจนานุกรมยังไม่รู้จัก — ต้องมีคนมาเติม courses.ts */
  unknownCourseHeaders: string[];
  /** แถวที่ไม่มีสัญญาณการชำระเลย (ว่าง/ขยะ) — ไม่สร้าง doc */
  skipped: number;
  /** จำนวนแถวข้อมูลทั้งหมดที่พิจารณา */
  rows: number;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** ยอดเงิน — ตัด comma, ต้อง > 0 ไม่งั้นถือว่าไม่มี (ตรงกับ as_amount ใน profiler) */
function amount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function age(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) && n > 0 && n < 120 ? n : null;
}

/** วันที่ Excel: Date จาก lib ก็ใช้เลย · number = serial (1900 system) · string = ลองแปลง */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial (1900 system): 25569 = 1970-01-01 ซึ่งกลบ bug ปี 1900 ไว้แล้ว
    // ข้อมูลชีตเป็นปี 2025/2026 ทั้งหมด ไม่แตะช่วง <1900-03 ที่ off-by-one
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = str(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const freshSync = () => ({ dirty: true, syncedAt: null, lockedAt: null, attempts: 0 });

/**
 * แปลงแถวจริงเป็น doc ฐาน legacy
 *
 * dedupe คน: เบอร์ (normalize) > อีเมล (lower) > แถว (แยกไม่ได้ = คนละคน)
 * — คีย์เดียวกับที่ match/build ใช้จับกับลูกค้า LINE ทีหลัง
 */
export function importLegacyRows(opts: ImportLegacyOptions): ImportedLegacy {
  const now = opts.now ?? new Date();
  const out: ImportedLegacy = {
    persons: [],
    payments: [],
    enrollments: [],
    unknownCourseHeaders: [],
    skipped: 0,
    rows: 0,
  };

  const byKey = new Map<string, LegacyPersonDoc>();
  let uniqueSeq = 0;

  for (const sheet of opts.sheets) {
    const year = sheetYear(sheet.sheet);

    for (const row of sheet.rows) {
      out.rows++;
      const source = { sheet: sheet.sheet, row: row.rowNumber };

      const paidAt = toDate(row.fields.paidAt);
      const amt = amount(row.fields.amount);
      const slipNo = str(row.fields.slipNo);

      // ตีความคอร์สก่อน เพื่อรู้ว่าแถวนี้มีสัญญาณอะไรบ้าง
      const parsedCourses: {
        label: string;
        code: string;
        parsed: ReturnType<typeof parseCourseCell>;
      }[] = [];
      for (const cell of row.courses) {
        const parsed = parseCourseCell(cell.value, year);
        if (!parsed) continue;
        const def = courseByHeader(cell.label);
        if (!def) {
          if (!out.unknownCourseHeaders.includes(cell.label)) out.unknownCourseHeaders.push(cell.label);
          continue;
        }
        parsedCourses.push({ label: cell.label, code: def.code, parsed });
      }

      // ไม่มีสัญญาณการชำระเลย = แถวขยะ (หัวตาราง/แถวว่าง/สรุปท้ายชีต) — ไม่สร้าง doc
      if (!paidAt && amt === null && !slipNo && parsedCourses.length === 0) {
        out.skipped++;
        continue;
      }

      // ── identity + dedupe ────────────────────────────────────────────────
      const phone = normalizePhone(row.fields.phone);
      const email = str(row.fields.email)?.toLowerCase() ?? null;
      const key = phone ?? email ?? `row:${source.sheet}:${source.row}:${uniqueSeq++}`;

      let person = byKey.get(key);
      if (!person) {
        person = {
          _id: newId("legacyPerson"),
          fullNameTh: str(row.fields.fullNameTh),
          fullNameEn: str(row.fields.fullNameEn),
          nickname: str(row.fields.nickname),
          phone,
          email,
          socialHandle: str(row.fields.social),
          ageAtImport: age(row.fields.age),
          firstPaidAt: null,
          lastPaidAt: null,
          totalPaid: 0,
          paymentCount: 0,
          seatCount: 0,
          courseCodes: [],
          sourceRefs: [],
          synthetic: false,
          importRunId: opts.importRunId,
          createdAt: now,
          updatedAt: now,
          schemaVersion: LEGACY_SCHEMA_VERSION,
          aiSync: freshSync(),
        };
        byKey.set(key, person);
        out.persons.push(person);
      } else {
        // แถวซ้ำของคนเดิม — เติมช่องที่แถวแรกว่างไว้ ไม่ทับของเดิม
        person.fullNameTh ??= str(row.fields.fullNameTh);
        person.fullNameEn ??= str(row.fields.fullNameEn);
        person.nickname ??= str(row.fields.nickname);
        person.email ??= email;
        person.phone ??= phone;
        person.socialHandle ??= str(row.fields.social);
        person.ageAtImport ??= age(row.fields.age);
      }

      // ── payment (ถือ "เงิน" ที่นี่ที่เดียว) ───────────────────────────────
      const payment: LegacyPaymentDoc = {
        _id: newId("legacyPayment"),
        personId: person._id,
        slipNo,
        slipShared: false, // เติมทีหลังเมื่อรู้ว่าเลขสลิปซ้ำข้ามแถว
        amount: amt,
        paidAt,
        year,
        saleRep: str(row.fields.saleRep),
        source,
        synthetic: false,
        importRunId: opts.importRunId,
        createdAt: now,
        updatedAt: now,
        schemaVersion: LEGACY_SCHEMA_VERSION,
        aiSync: freshSync(),
      };
      out.payments.push(payment);

      // ── enrollments (ถือ "ที่นั่ง") ───────────────────────────────────────
      for (const { label, code, parsed } of parsedCourses) {
        if (!parsed) continue;
        out.enrollments.push({
          _id: newId("legacyEnrollment"),
          personId: person._id,
          paymentId: payment._id,
          courseCode: code,
          courseLabel: label,
          kind: parsed.kind,
          countsAsSeat: parsed.countsAsSeat,
          sessionLabel: parsed.sessionLabel,
          sessionStart: parsed.sessionStart,
          sessionPrecision: parsed.sessionPrecision,
          sessionYear: parsed.sessionYear,
          refSlip: parsed.refSlip,
          substitute: parsed.substitute,
          raw: parsed.raw,
          source,
          synthetic: false,
          importRunId: opts.importRunId,
          createdAt: now,
          updatedAt: now,
          schemaVersion: LEGACY_SCHEMA_VERSION,
          aiSync: freshSync(),
        });

        if (parsed.countsAsSeat) {
          person.seatCount++;
          if (!person.courseCodes.includes(code)) person.courseCodes.push(code);
        }
      }

      // ── สรุประดับคน (ยอดรวมจาก payments เท่านั้น ห้ามบวกจาก enrollments) ──
      person.paymentCount++;
      person.totalPaid += amt ?? 0;
      person.sourceRefs.push(source);
      if (paidAt && (!person.firstPaidAt || paidAt < person.firstPaidAt)) person.firstPaidAt = paidAt;
      if (paidAt && (!person.lastPaidAt || paidAt > person.lastPaidAt)) person.lastPaidAt = paidAt;
    }
  }

  // เลขสลิปที่ใช้ซ้ำข้ามแถว = จ่ายรวมกันมา ยอดอาจซ้อนกัน — กำกับไว้ให้ analytics ระวัง
  const bySlip = new Map<string, LegacyPaymentDoc[]>();
  for (const p of out.payments) {
    if (!p.slipNo) continue;
    const list = bySlip.get(p.slipNo);
    if (list) list.push(p);
    else bySlip.set(p.slipNo, [p]);
  }
  for (const [, list] of bySlip) {
    if (list.length > 1) for (const p of list) p.slipShared = true;
  }

  return out;
}
