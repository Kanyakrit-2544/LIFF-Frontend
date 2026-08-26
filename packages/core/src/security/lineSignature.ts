import crypto from "node:crypto";

/**
 * ตรวจ x-line-signature (docs/03 §3.3)
 *
 * ⚠️ ต้องคำนวณจาก **raw body** ที่ยังไม่ผ่าน JSON.parse
 * ถ้า parse แล้ว stringify ใหม่ ลำดับ key หรือช่องว่างอาจเปลี่ยน → signature ไม่ตรงทั้งที่ request ถูกต้อง
 */
export function verifyLineSignature(rawBody: string, signature: string | null, channelSecret: string): boolean {
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", channelSecret).update(rawBody, "utf8").digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  // timingSafeEqual จะ throw ถ้าความยาวไม่เท่ากัน — เช็คก่อนเพื่อไม่ให้ throw กลายเป็น 500
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(received, expected);
}

/** ใช้ในสคริปต์ทดสอบเพื่อสร้าง request ที่ signature ถูกต้อง */
export function signLineBody(rawBody: string, channelSecret: string): string {
  return crypto.createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");
}
