/**
 * ตีความ "เซลล์คอร์ส" ในชีตขาย
 *
 * เซลล์ไม่ได้มีแค่เครื่องหมายติ๊ก — มันเก็บความหมายทางธุรกิจไว้ในข้อความ เช่น
 *   "27-28 Jun"                       ลงเรียนรอบนั้น
 *   "RL 30-31 Aug"                    Relearn (ใช้สิทธิ์เรียนซ้ำ ไม่ใช่ที่นั่งขายใหม่)
 *   "Free 17-18 Jan"                  ได้สิทธิ์ฟรี
 *   "17-18 Jan 26"                    รอบข้ามปี
 *   "เพิ่ม IN-6806-00164"              รายการปรับ อ้างสลิปอื่น
 *   "ย้ายเรียน Camp"                   ย้ายคอร์ส
 *   "13-14 Jun คุณสมชาย ใจดี เรียนแทน"  มีคนอื่นเรียนแทน ← มี "ชื่อคนจริง" ฝังอยู่ในเซลล์
 *   "Wait" / "คืนเงิน" / "ค่าปรับ" / "หนังสือ" / "ห้องพัก"
 *
 * ถ้านับทุกเซลล์ที่ไม่ว่างเป็น "ขายได้ 1 ที่นั่ง" ตัวเลขจะเกินจริง —
 * relearn/waitlist/refund/สินค้า ไม่ใช่ที่นั่งที่ขายได้
 *
 * ⚠️ `raw` และ `note` อาจมีชื่อคนจริง — ห้ามส่งออกจากฐาน legacy โดยไม่ scrub (ดู scrubLegacy.ts)
 */

export type EnrollmentKind =
  | "enrolled"
  | "relearn"
  | "free"
  | "waitlist"
  | "transfer"
  | "adjustment"
  | "penalty"
  | "refund"
  | "merchandise"
  | "unknown";

export interface ParsedCourseCell {
  kind: EnrollmentKind;
  /** ป้ายรอบเรียนที่สะอาดแล้ว เช่น "27-28 Jun" — null เมื่อเซลล์ไม่ได้ระบุรอบ */
  sessionLabel: string | null;
  sessionYear: number | null;
  /** วันแรกของรอบ — null เมื่อระบุได้แค่เดือน หรือแกะไม่ออก */
  sessionStart: Date | null;
  sessionPrecision: "day" | "month" | "none";
  /** เลขสลิปที่เซลล์อ้างถึง (รายการปรับ) */
  refSlip: string | null;
  /** มีคนเรียนแทน — เซลล์มีชื่อคนจริงฝังอยู่ */
  substitute: boolean;
  /** true = ไม่ใช่ที่นั่งที่ขายได้ ห้ามนับใน "ยอดคนเรียน" */
  countsAsSeat: boolean;
  raw: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const SLIP_RE = /\b(IN-\d{4}-\d{5})\b/i;

/** รอบเรียนที่ "ขายได้จริง" — relearn/free เป็นสิทธิ์ ไม่ใช่ยอดขายใหม่ */
const SEAT_KINDS = new Set<EnrollmentKind>(["enrolled"]);

function parseSession(label: string, sheetYear: number): Pick<ParsedCourseCell, "sessionLabel" | "sessionYear" | "sessionStart" | "sessionPrecision"> {
  const cleaned = label.replace(/\s+/g, " ").trim();
  if (!cleaned) return { sessionLabel: null, sessionYear: null, sessionStart: null, sessionPrecision: "none" };

  const tokens = cleaned.replace(/[,\-–—]/g, " ").split(/\s+/).filter(Boolean);
  const isMonth = (t: string) => MONTHS.indexOf(t.slice(0, 3).toLowerCase()) >= 0;
  const monthIdx = tokens.findIndex(isMonth);
  if (monthIdx < 0) return { sessionLabel: cleaned, sessionYear: null, sessionStart: null, sessionPrecision: "none" };

  const month = MONTHS.indexOf(tokens[monthIdx]!.slice(0, 3).toLowerCase());
  const before = tokens.slice(0, monthIdx).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
  // ปีต้องอยู่หลัง "เดือนตัวสุดท้าย" เท่านั้น — ไม่งั้น "31 May - 1 Jun" จะอ่าน 1 เป็นปี 2001
  const lastMonthIdx = tokens.map(isMonth).lastIndexOf(true);
  const tail = tokens.slice(lastMonthIdx + 1);
  const after = tail.map(Number).filter((n) => Number.isInteger(n));

  // "30,31 Jan-1 Feb" → วันแรกคือ 30 ไม่ใช่ 31 จึงหยิบ "ตัวแรก" ที่อยู่หน้าเดือน
  let day = before.length > 0 ? before[0]! : null;
  let year = sheetYear;

  if (day === null) {
    // "Jan 23" — ไม่มีเลขนำหน้าเดือน ตัวเลขที่ตามมาคือวัน
    if (after.length > 0 && after[0]! >= 1 && after[0]! <= 31) day = after[0]!;
  } else {
    // มีวันแล้ว เลขที่เขียนเป็น 2 หลักหลังเดือนสุดท้ายคือปี ค.ศ. ย่อ: "17-18 Jan 26" = ม.ค. 2026
    const yy = tail.find((t) => /^\d{2}$/.test(t));
    if (yy !== undefined) year = 2000 + Number(yy);
  }

  if (day === null) {
    return { sessionLabel: cleaned, sessionYear: year, sessionStart: new Date(Date.UTC(year, month, 1)), sessionPrecision: "month" };
  }
  return { sessionLabel: cleaned, sessionYear: year, sessionStart: new Date(Date.UTC(year, month, day)), sessionPrecision: "day" };
}

/** null = เซลล์ว่าง (ไม่ได้ลงคอร์สนี้) */
export function parseCourseCell(value: unknown, sheetYear: number): ParsedCourseCell | null {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const base = {
    sessionLabel: null as string | null,
    sessionYear: null as number | null,
    sessionStart: null as Date | null,
    sessionPrecision: "none" as const,
    refSlip: raw.match(SLIP_RE)?.[1]?.toUpperCase() ?? null,
    substitute: false,
    raw,
  };
  const done = (kind: EnrollmentKind, extra: Partial<ParsedCourseCell> = {}): ParsedCourseCell => ({
    ...base,
    ...extra,
    kind,
    countsAsSeat: SEAT_KINDS.has(kind) && extra.countsAsSeat !== false,
  });

  const lower = raw.toLowerCase();

  if (raw.includes("คืนเงิน")) return done("refund");
  if (raw.includes("ค่าปรับ")) return done("penalty");
  if (raw.includes("ตัดสิทธิ")) return done("adjustment");
  // "ปรับ IN-6804-00006" = รายการปรับ ต่างจาก "ค่าปรับ" ที่ดักไปแล้วข้างบน
  if (/^ปรับ/.test(raw)) return done("adjustment");
  // \b ใช้กับคำไทยไม่ได้ (อักษรไทยไม่ใช่ \w) จึงเทียบด้วยการขึ้นต้นตรง ๆ
  if (/^(เพิ่ม|เลื่อน)/.test(raw) || /^up pack\b/i.test(raw)) return done("adjustment");
  if (base.refSlip && !/\d{1,2}\s*[-–]/.test(raw)) return done("adjustment");
  if (/^(ย้าย|เปลี่ยนเป็น)/.test(raw)) return done("transfer");
  if (lower === "wait" || lower.startsWith("wait ")) return done("waitlist");
  // ของแถม/สินค้า/ค่าห้องพัก — ไม่ใช่ที่นั่งคอร์ส
  if (/^(หนังสือ|ผ้าคลุม|ห้องพัก|พักเดี่ยว)/.test(raw)) return done("merchandise");

  let rest = raw;
  let kind: EnrollmentKind = "enrolled";

  // "Free RL 30-31 Aug" มีทั้งสองคำได้ — Free ชนะเพราะสะท้อนว่าไม่มีรายได้
  if (/^rl\b/i.test(rest)) {
    kind = "relearn";
    rest = rest.replace(/^rl\b/i, "").trim();
  }
  if (/^free\b/i.test(rest)) {
    kind = "free";
    rest = rest.replace(/^free\b/i, "").trim();
  }
  if (/^rl\b/i.test(rest)) {
    if (kind !== "free") kind = "relearn";
    rest = rest.replace(/^rl\b/i, "").trim();
  }

  // "หนังสือ RL" → RL ถูกตัดไปแล้ว เหลือคำสินค้า
  if (/^(หนังสือ|ผ้าคลุม|ห้องพัก|พักเดี่ยว)/.test(rest)) return done("merchandise");

  const substitute = /เรียนแทน/.test(rest);
  if (substitute) rest = rest.replace(/คุณ.*$/, "").trim();
  // "27-28 Jun D-1" — D-1 คือรอบวันแรก ไม่ใช่ส่วนของวันที่
  rest = rest.replace(/\bD-\d\b/i, "").trim();
  // "8-9 Mar ย้ายเรียน IN" — มีรอบ แต่สุดท้ายย้ายออก
  if (/ย้าย/.test(rest)) {
    const moved = parseSession(rest.replace(/ย้าย.*$/, "").trim(), sheetYear);
    return { ...base, ...moved, kind: "transfer", substitute, countsAsSeat: false };
  }

  const session = parseSession(rest, sheetYear);
  if (session.sessionPrecision === "none" && kind === "enrolled") {
    // เขียนอะไรมาก็ไม่รู้ — ทำเป็น unknown ดีกว่าเดาว่าขายได้
    return { ...base, ...session, kind: "unknown", substitute, countsAsSeat: false };
  }
  return { ...base, ...session, kind, substitute, countsAsSeat: SEAT_KINDS.has(kind) };
}
