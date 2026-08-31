import type { ClientSession, Db } from "mongodb";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { log } from "../logger";

/**
 * ลบข้อมูลส่วนบุคคลตามคำขอของลูกค้า (PDPA สิทธิ์ขอให้ลบ)
 *
 * ⭐ ไม่ใช่การลบทิ้งทั้งหมด แต่เป็นการ **ตัดตัวตนออกจากธุรกรรม**
 *
 * เหตุผล: การซื้อขายเป็นเอกสารทางบัญชีที่มีกฎหมายอื่นบังคับให้เก็บ
 * ถ้าลบ `purchases` ทิ้ง ยอดขายย้อนหลังจะเปลี่ยนและงบการเงินไม่ตรง
 * จึงลบสิ่งที่ระบุตัวคนได้ออก แล้วเหลือธุรกรรมที่ผูกกับรหัสที่ไม่ชี้ไปหาใครแล้ว
 *
 * สิ่งที่ถูกลบจริง
 * - ชื่อ เบอร์ อีเมล social ทั้งหมดใน `customers`
 * - `customer_profiles` — คำตอบในฟอร์มทั้งหมด (เป็น free text อ่อนไหวที่สุด)
 * - `identities` — ตัดการเชื่อมกับ LINE user (ทักเข้ามาใหม่ = ลูกค้าใหม่ ถูกต้องแล้ว)
 * - `customer_intents` — ค่าประเมินพฤติกรรม เป็นการทำโปรไฟล์ ไม่ใช่เอกสารบัญชี
 *
 * สิ่งที่เหลือไว้
 * - `purchases` / `purchase_items` ผูกกับ `customerId` ที่ไม่มี PII เหลือแล้ว
 *
 * ⚠️ ขอบเขต: ครอบเฉพาะ `line_crm_dev` และสำเนาใน `line_crm_ai`
 * ประวัติในชีตขาย (`line_crm_legacy`) เป็นระบบเอกสารคนละชุด ต้องจัดการแยก
 */

export interface EraseResult {
  customerId: string;
  erasedAt: Date;
  removed: { profiles: number; identities: number; intents: number };
}

export async function eraseCustomer(
  db: Db,
  customerId: string,
  reason: string,
  now = new Date(),
  session?: ClientSession
): Promise<EraseResult> {
  const opts = session ? { session } : {};

  const profiles = await db.collection(COLLECTIONS.customerProfiles).deleteMany({ customerId }, opts);
  const identities = await db.collection(COLLECTIONS.identities).deleteMany({ customerId }, opts);
  const intents = await db.collection(COLLECTIONS.customerIntents).deleteMany({ customerId }, opts);

  await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
    { _id: customerId },
    {
      $set: {
        status: "erased",
        title: null, displayName: null, nickname: null, fullNameEn: null,
        phone: null, email: null, facebook: null, instagram: null,
        lineDisplayName: null, pictureUrl: null, birthYear: null, heardFrom: null,
        leadAttribution: null, pendingMerge: null,
        profileRef: null,
        tags: [],
        erasedAt: now,
        eraseReason: reason,
        updatedAt: now,
        // ให้ชีตและ AI mirror เขียนทับด้วยฉบับที่ลบแล้ว
        "sheetSync.dirty": true, "sheetSync.lockedAt": null, "sheetSync.attempts": 0,
        "aiSync.dirty": true, "aiSync.lockedAt": null, "aiSync.attempts": 0,
      },
    },
    opts
  );

  await db.collection(COLLECTIONS.auditLogs).insertOne(
    {
      actor: "partner:erase",
      action: "customer.erased",
      customerId,
      at: now,
      // ไม่บันทึกค่าที่ลบไป — จะกลายเป็นสำเนาของสิ่งที่เพิ่งลบ
      meta: { reason, removed: { profiles: profiles.deletedCount, identities: identities.deletedCount, intents: intents.deletedCount } },
    } as never,
    opts
  );

  log.info("ลบข้อมูลส่วนบุคคลตามคำขอ", {
    customerId,
    profiles: profiles.deletedCount,
    identities: identities.deletedCount,
    intents: intents.deletedCount,
  });

  return {
    customerId,
    erasedAt: now,
    removed: { profiles: profiles.deletedCount, identities: identities.deletedCount, intents: intents.deletedCount },
  };
}
