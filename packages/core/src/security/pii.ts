import crypto from "node:crypto";
import { env } from "../env";
import { toLocalPhone } from "../identity/normalize";

/**
 * รูปแบบการเก็บ PII (docs/02 §2.6)
 *   <field>Hash   = HMAC-SHA256(normalized, PEPPER)  → index/dedupe/match — ย้อนกลับไม่ได้
 *   <field>Enc    = AES-256-GCM(plaintext, KEY)      → ถอดได้เมื่อมีสิทธิ์
 *   <field>Masked = ค่าที่ปลอดภัยพอจะใส่ log/UI
 *
 * KEY กับ PEPPER แยกกันโดยตั้งใจ: KEY หมุนได้ (มี version prefix) แต่ PEPPER ห้ามเปลี่ยน
 */

const VERSION = "v1";

let keyCache: Buffer | null = null;
function key(): Buffer {
  if (!keyCache) keyCache = Buffer.from(env("pii").PII_KEY, "base64");
  return keyCache;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4) throw new Error("รูปแบบ ciphertext ไม่ถูกต้อง");
  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error(`ไม่รองรับ ciphertext เวอร์ชัน ${version}`);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** deterministic — ค่าเดิมได้ hash เดิมเสมอ จึงใช้เป็น index ได้ */
export function hashValue(normalized: string): string {
  return crypto.createHmac("sha256", env("pii").PII_PEPPER).update(normalized).digest("hex");
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const local = toLocalPhone(phone).replace(/\D/g, "");
  if (local.length < 6) return "xxx";
  return `${local.slice(0, 2)}x-xxx-${local.slice(-4)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${domain}`;
}

export type PiiTriple = { hash: string; enc: string; masked: string };

export function packPhone(normalizedE164: string): PiiTriple {
  return { hash: hashValue(normalizedE164), enc: encrypt(normalizedE164), masked: maskPhone(normalizedE164) };
}

export function packEmail(normalizedEmail: string): PiiTriple {
  return { hash: hashValue(normalizedEmail), enc: encrypt(normalizedEmail), masked: maskEmail(normalizedEmail) };
}

/** ค่าที่จะเขียนลง Sheets — D15 ตั้งไว้เป็น full แต่สลับได้ด้วย env ตัวเดียว */
export function forSheet(triple: { enc: string; masked: string } | null | undefined): string {
  if (!triple) return "";
  return env("sheets").SHEETS_PII_MODE === "full" ? decrypt(triple.enc) : triple.masked;
}
