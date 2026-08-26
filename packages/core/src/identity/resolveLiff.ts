import { getDb } from "../db/client";
import { COLLECTIONS, type IdentityDoc } from "../db/models";
import { resolveCustomer, type ResolveCustomerResult } from "./resolve";
import { env } from "../env";

/**
 * หาลูกค้าจาก LIFF login
 *
 * ปัญหาที่ต้องระวัง: คนคนเดียวเข้ามาได้สองทาง
 *   - แอดเพื่อน → webhook → identity { provider:"line", channelId: <destination> }
 *   - เปิด LIFF  → id_token → sub
 *
 * LINE ใช้ user id เดียวกันทุก channel ที่อยู่ใต้ provider เดียวกัน → `sub` = `source.userId` ตัวเดิม
 * ถ้าไป resolve ด้วย (provider:"line_login", channelId: <login channel>) ตรง ๆ จะไม่เจอ identity เดิม
 * แล้ว **สร้างลูกค้าใหม่ซ้ำกับคนเดิมที่เพิ่งแอดเพื่อนมา**
 *
 * จึงค้นจาก externalId ก่อนโดยไม่สนใจ channelId แล้วค่อย fallback ไปสร้างใหม่
 */
export async function resolveLiffCustomer(lineUserId: string): Promise<ResolveCustomerResult> {
  const db = await getDb();
  const identities = db.collection<IdentityDoc>(COLLECTIONS.identities);

  // 1. เคยเข้ามาทางไหนก็ได้ที่เป็น LINE — ใช้ลูกค้าคนนั้น
  const existing = await identities.findOne(
    { externalId: lineUserId, provider: { $in: ["line", "line_login"] } },
    { sort: { linkedAt: 1 } } // ตัวที่ผูกไว้ก่อนคือตัวจริง
  );

  if (existing) {
    // resolve ผ่านตัวเดิมเพื่อให้ตามสาย merge ได้ถูก
    return resolveCustomer({
      provider: existing.provider,
      channelId: existing.channelId,
      externalId: lineUserId,
    });
  }

  // 2. ไม่เคยเจอ — เปิด LIFF ก่อนแอดเพื่อน (เกิดได้ถ้าได้ลิงก์มาจากที่อื่น)
  return resolveCustomer({
    provider: "line_login",
    channelId: env("line").LINE_LOGIN_CHANNEL_ID,
    externalId: lineUserId,
    verified: true,
    meta: { source: "liff" },
    create: { sourceChannel: "line" },
  });
}
