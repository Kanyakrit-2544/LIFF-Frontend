import { getDb } from "../db/client";
import { log } from "../logger";

/**
 * Rate limit แบบ fixed window เก็บใน MongoDB (docs/03 §3.13)
 *
 * ใช้ Mongo เพราะยังไม่มี Redis ในระบบ — พอสำหรับปริมาณระดับนี้
 * ถ้าโตจนเป็นคอขวดให้ย้ายไป Upstash Redis โดยเปลี่ยนแค่ไฟล์นี้
 *
 * ⚠️ atomic ด้วย $inc + upsert → หลาย instance ของ Vercel นับรวมกันถูกต้อง
 */

const COLLECTION = "rate_limits";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export async function checkRateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSec * 1000)) * windowSec * 1000;
  const id = `${key}:${windowStart}`;

  try {
    const col = (await getDb()).collection(COLLECTION);
    const doc = await col.findOneAndUpdate(
      { _id: id as never },
      { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowSec * 1000) } },
      { upsert: true, returnDocument: "after" }
    );
    const n = (doc as { n?: number } | null)?.n ?? 1;
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowSec * 1000 - now) / 1000));
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterSec };
  } catch (e) {
    // DB มีปัญหา → ปล่อยผ่าน ดีกว่าทำให้ผู้ใช้จริงส่งฟอร์มไม่ได้
    log.warn("rate limit ตรวจไม่ได้ ปล่อยผ่าน", { key, error: (e as Error).message });
    return { allowed: true, remaining: limit, retryAfterSec: 0 };
  }
}

export async function ensureRateLimitIndex(): Promise<void> {
  await (await getDb())
    .collection(COLLECTION)
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl_expiresAt" });
}
