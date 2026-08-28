import crypto from "node:crypto";

/**
 * ตรวจลายเซ็น webhook ของ Meta (Facebook/Instagram)
 *
 * ต่างจาก LINE ตรงที่ header เป็น `sha256=<hex>` และเซ็นด้วย **App Secret** ไม่ใช่ page token
 * และ Meta ไม่ใส่ timestamp มาด้วย จึงกัน replay ที่ชั้นนี้ไม่ได้ —
 * ต้องกันด้วย idempotency ของ leadgen_id แทน (ดู docs/28 §3.2)
 */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  // ความยาวต่างกัน timingSafeEqual จะ throw — เช็คก่อนเสมอ
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
