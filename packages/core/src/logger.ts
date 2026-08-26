/**
 * Structured log + redact PII อัตโนมัติ
 * เหตุผล: docs/06 §6.11 มีเคสทดสอบว่า grep เบอร์โทรจริงใน log ต้องไม่เจอ
 * การพึ่งวินัยของคนเขียนโค้ดไม่พอ — redact ที่ชั้น logger จึงเป็นตาข่ายสุดท้าย
 */

const REDACTIONS: Array<[RegExp, string]> = [
  // ไทย: +66 81 234 5678 / 66812345678
  [/\+?66[-\s]?\d{1,2}[-\s]?\d{3}[-\s]?\d{4}\b/g, "[PHONE]"],
  // ไทย: 081-234-5678 (มือถือ 10 หลัก) และ 02-123-4567 (เบอร์บ้าน 9 หลัก)
  [/\b0\d{1,2}[-\s]?\d{3}[-\s]?\d{4}\b/g, "[PHONE]"],
  [/\b[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}\b/gi, "[EMAIL]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT]"],
  [/\b\d[-\s]?\d{4}[-\s]?\d{5}[-\s]?\d{2}[-\s]?\d\b/g, "[NATIONAL_ID]"],
];

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // field ที่ชื่อบ่งบอกว่าเป็นความลับ ตัดทิ้งทั้งค่าไม่ต้องเดา
      out[k] = /secret|token|password|pepper|_key$|^key$|Enc$/i.test(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    msg,
    at: new Date().toISOString(),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
