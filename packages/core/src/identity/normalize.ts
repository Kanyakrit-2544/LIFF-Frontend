/**
 * Normalize ก่อน hash เสมอ — ไม่งั้น "081-234-5678" กับ "0812345678" จะกลายเป็นคนละคน
 * ทุกฟังก์ชันคืน null เมื่อ input ใช้ไม่ได้ (ไม่ throw) เพราะ caller เป็นคนตัดสินว่า required หรือไม่
 */

/** เบอร์ไทย → E.164 (+66xxxxxxxxx) */
export function normalizePhone(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const hadPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let national: string;

  if (hadPlus) {
    // ระบุ country code มาแล้ว — รองรับเฉพาะไทย
    if (!digits.startsWith("66")) return null;
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else if (digits.startsWith("66") && digits.length === 11) {
    // 66812345678 — ความยาว 11 เท่านั้น กัน 661234567 ที่เป็นเบอร์ 066 ที่ตกเลข 0
    national = digits.slice(2);
  } else if (digits.length === 9) {
    // 812345678 — ตกเลข 0 นำหน้า
    national = digits;
  } else {
    return null;
  }

  // มือถือ = 9 หลักขึ้นต้น 6/8/9 · เบอร์บ้าน = 8 หลักขึ้นต้น 2-7
  if (!/^[2-9]\d{7,8}$/.test(national)) return null;
  return `+66${national}`;
}

/** E.164 กลับเป็นรูปแบบที่คนไทยอ่านออก: +66812345678 → 0812345678 */
export function toLocalPhone(e164: string): string {
  return e164.startsWith("+66") ? `0${e164.slice(3)}` : e164;
}

export function normalizeEmail(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const v = String(input).trim().toLowerCase();
  if (!v || v.length > 254) return null;
  // ตั้งใจไม่ใช้ regex RFC เต็ม — จับพวก typo ชัด ๆ พอ ความถูกต้องจริงยืนยันด้วยการส่งเมล
  if (!/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(v)) return null;
  return v;
}

const TITLES = [
  "นาย", "นางสาว", "นาง", "น.ส.", "ด.ช.", "ด.ญ.", "คุณ", "ดร.", "ผศ.", "รศ.", "ศ.",
  "mr.", "mrs.", "ms.", "miss", "dr.", "mr", "mrs", "ms", "dr",
];

/** ตัดคำนำหน้า + ยุบช่องว่าง — ใช้เทียบชื่อ ไม่ใช่ค่าที่เอาไปแสดง */
export function normalizeName(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  let v = String(input).normalize("NFC").replace(/\s+/g, " ").trim();
  if (!v) return null;

  const lower = v.toLowerCase();
  for (const t of TITLES) {
    if (lower.startsWith(t)) {
      const rest = v.slice(t.length).trim();
      if (rest.length >= 2) {
        v = rest;
        break;
      }
    }
  }
  return v.length >= 2 ? v : null;
}

const CURRENT_BE = new Date().getFullYear() + 543;

/** ปีเกิด พ.ศ. (D16) — รับ 2450 ถึง (ปีปัจจุบัน − 5) */
export function normalizeBirthYearBE(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const n = Number(String(input).trim());
  if (!Number.isInteger(n)) return null;
  // เผื่อผู้ใช้กรอก ค.ศ. มา
  const be = n < 2400 && n > 1900 ? n + 543 : n;
  if (be < 2450 || be > CURRENT_BE - 5) return null;
  return be;
}

export function ageFromBirthYearBE(be: number, now = new Date()): number {
  return now.getFullYear() + 543 - be;
}
