import crypto from "node:crypto";
import { env } from "../env";
import { toLocalPhone } from "../identity/normalize";

/**
 * PII helper หลัง S9:
 * - DB หลักเก็บ phone/email เป็น plaintext normalized
 * - AI mirror ใช้ mask + HMAC ด้วย AI_HASH_PEPPER แยกต่างหาก
 * - ไม่มี AES decrypt path ใน app แล้ว
 */

/** deterministic — ค่าเดิมได้ hash เดิมเสมอ จึงใช้เป็น index ได้ */
export function hashValue(normalized: string, pepper = env("ai").AI_HASH_PEPPER): string {
  return crypto.createHmac("sha256", pepper).update(normalized).digest("hex");
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const local = toLocalPhone(phone).replace(/\D/g, "");
  if (local.length < 6) return "xxx";
  return `${local.slice(0, 2)}x-xxx-${local.slice(-4)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const first = email.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (!first) return "***";
  const at = first.indexOf("@");
  const local = first.slice(0, at);
  const domain = first.slice(at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${domain}`;
}
