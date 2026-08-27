import { ageFromBirthYearBE } from "../identity/normalize";
import { log } from "../logger";
import type { CustomerDoc } from "../db/models";

/**
 * แปลง customer เป็นแถวใน Google Sheets (docs/08 §8.3)
 *
 * นิยามคอลัมน์อยู่ที่นี่ที่เดียว — ทั้งหัวตาราง, การเขียนแถว และสคริปต์ตั้งค่าชีต อ่านจากก้อนนี้
 * เพิ่ม/สลับคอลัมน์แก้ที่เดียวจบ ไม่ต้องไล่แก้หลายที่ให้ตรงกัน
 *
 * ⚠️ `staffNote` ต้องเป็นคอลัมน์สุดท้ายเสมอ — ระบบเขียนถึงแค่คอลัมน์ก่อนหน้า
 *    พนักงานจดอะไรไว้ตรงนั้นจะไม่ถูกทับ (docs/08)
 */

export interface SheetColumn {
  id: string;
  header: string;
  /** system = ระบบเขียน · staff = พนักงานกรอกเอง ระบบห้ามแตะ */
  owner: "system" | "staff";
  value?: (c: CustomerDoc) => string;
}

const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "");
const dt = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 16).replace("T", " ") : "");

export const SHEET_COLUMNS: SheetColumn[] = [
  { id: "customerId", header: "Customer ID", owner: "system", value: (c) => c._id },
  { id: "fullNameTh", header: "ชื่อ-นามสกุล", owner: "system", value: (c) => c.displayName ?? "" },
  { id: "nickname", header: "ชื่อเล่น", owner: "system", value: (c) => c.nickname ?? "" },
  { id: "fullNameEn", header: "Name Eng.", owner: "system", value: (c) => c.fullNameEn ?? "" },
  { id: "birthYear", header: "ปีเกิด (พ.ศ.)", owner: "system", value: (c) => (c.birthYear ? String(c.birthYear) : "") },
  { id: "age", header: "อายุ", owner: "system", value: (c) => (c.birthYear ? String(ageFromBirthYearBE(c.birthYear)) : "") },
  { id: "phone", header: "เบอร์", owner: "system", value: (c) => c.phone ?? "" },
  { id: "email", header: "อีเมล", owner: "system", value: (c) => c.email ?? "" },
  { id: "lineDisplayName", header: "ชื่อใน LINE", owner: "system", value: (c) => c.lineDisplayName ?? "" },
  { id: "facebook", header: "Facebook", owner: "system", value: (c) => c.facebook ?? "" },
  { id: "instagram", header: "Instagram", owner: "system", value: (c) => c.instagram ?? "" },
  { id: "status", header: "สถานะ", owner: "system", value: (c) => c.customerStatus ?? "" },
  { id: "source", header: "ช่องทางที่มา", owner: "system", value: (c) => (c.sources ?? []).join(", ") },
  { id: "tags", header: "แท็ก", owner: "system", value: (c) => (c.tags ?? []).join(", ") },
  { id: "firstInteractionAt", header: "วันที่แอดเพื่อน", owner: "system", value: (c) => d(c.firstInteractionAt) },
  { id: "firstMessageAt", header: "วันที่ทักครั้งแรก", owner: "system", value: (c) => d(c.firstMessageAt) },
  { id: "formSubmittedAt", header: "วันที่กรอกฟอร์ม", owner: "system", value: (c) => d(c.profileRef?.updatedAt ?? null) },
  { id: "consent", header: "PDPA", owner: "system",
    value: (c) => (c.consent?.dataProcessing ? `✓ ${d(c.consent.grantedAt)}` : "✗") },
  { id: "consentMarketing", header: "รับข่าวสาร", owner: "system", value: (c) => (c.consent?.marketing ? "✓" : "✗") },
  // ธงจาก docs/18 — เบอร์ซ้ำกับลูกค้าอีกคน รอเจ้าหน้าที่ตัดสินว่าเป็นคนเดียวกันไหม
  { id: "pendingMerge", header: "⚠️ เบอร์ซ้ำ รอตรวจ", owner: "system",
    value: (c) => (c.pendingMerge ? c.pendingMerge.candidateId : "") },
  { id: "updatedAt", header: "อัปเดตล่าสุด", owner: "system", value: (c) => dt(c.updatedAt) },
  // ── ต้องอยู่ท้ายสุดเสมอ ─────────────────────────────
  { id: "staffNote", header: "หมายเหตุพนักงาน", owner: "staff" },
];

/** คอลัมน์ที่ระบบเขียน = ทุกตัวก่อน staffNote */
export const SYSTEM_COLUMNS = SHEET_COLUMNS.filter((c) => c.owner === "system");
export const HEADERS = SHEET_COLUMNS.map((c) => c.header);
export const COLUMN_IDS = SHEET_COLUMNS.map((c) => c.id);

/** A, B, … Z, AA, AB … */
export function columnLetter(index0: number): string {
  let n = index0 + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** ช่วงที่ระบบเขียนได้ เช่น "A5:U5" — ไม่รวมคอลัมน์ของพนักงาน */
export function systemRange(rowIndex: number, sheetName = "Customers"): string {
  return `${sheetName}!A${rowIndex}:${columnLetter(SYSTEM_COLUMNS.length - 1)}${rowIndex}`;
}

export function toSheetRow(c: CustomerDoc): string[] {
  return SYSTEM_COLUMNS.map((col) => {
    try {
      return col.value?.(c) ?? "";
    } catch (e) {
      log.warn("สร้างค่าคอลัมน์ไม่ได้", { column: col.id, customerId: c._id, error: (e as Error).message });
      return "";
    }
  });
}
