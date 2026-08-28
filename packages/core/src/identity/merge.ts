import { ObjectId } from "mongodb";
import { getClient, getDb } from "../db/client";
import { COLLECTIONS, type AuditLogDoc, type CustomerDoc } from "../db/models";
import { log } from "../logger";
import { recomputeIntentCurrent } from "../partner/intents";
import type { CustomerIntentDoc } from "../partner/models";

/**
 * รวมลูกค้าสองคนเป็นคนเดียว (docs/02 §2.5)
 *
 * เกิดขึ้นเมื่อ: คนที่เพิ่งแอด LINE กรอกเบอร์ที่ตรงกับลูกค้าที่มีอยู่แล้ว
 *
 * ไม่ลบ loser ทิ้ง แต่ทำเป็น tombstone (`status:"merged"`, `mergedInto`) เพราะ
 * LINE / Google Sheets / ระบบอื่นอาจยังถือ id เก่าอยู่ — resolve ต้องตามไปเจอ winner ได้
 * และทำให้ย้อนกลับได้ถ้าตัดสินผิด
 */

export interface MergeResult {
  winnerId: string;
  loserId: string;
  moved: { identities: number; profiles: number; interactions: number; purchases: number; purchaseItems: number; intents: number };
}

/** เลือกว่าใครเป็นตัวหลัก: มี identity ยืนยันแล้วมากกว่า → เก่ากว่า → ข้อมูลครบกว่า */
export async function pickWinner(a: CustomerDoc, b: CustomerDoc): Promise<{ winner: CustomerDoc; loser: CustomerDoc }> {
  const identities = (await getDb()).collection(COLLECTIONS.identities);
  const [ca, cb] = await Promise.all([
    identities.countDocuments({ customerId: a._id, verified: true }),
    identities.countDocuments({ customerId: b._id, verified: true }),
  ]);
  if (ca !== cb) return ca > cb ? { winner: a, loser: b } : { winner: b, loser: a };

  const ta = a.createdAt?.getTime() ?? 0;
  const tb = b.createdAt?.getTime() ?? 0;
  if (ta !== tb) return ta < tb ? { winner: a, loser: b } : { winner: b, loser: a };

  const score = (c: CustomerDoc) =>
    [c.displayName, c.nickname, c.phone, c.email, c.birthYear, c.consent].filter(Boolean).length;
  return score(a) >= score(b) ? { winner: a, loser: b } : { winner: b, loser: a };
}

const FILL_FORWARD: (keyof CustomerDoc)[] = [
  "title", "heardFrom", "displayName", "nickname", "fullNameEn", "birthYear", "lineDisplayName",
  "pictureUrl", "facebook", "instagram", "phone", "email", "consent",
];

export async function mergeCustomers(winnerId: string, loserId: string, reason: string, actor = "system"): Promise<MergeResult> {
  if (winnerId === loserId) throw new Error("merge: winner กับ loser เป็นคนเดียวกัน");

  const db = await getDb();
  const client = await getClient();
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);

  const [winner, loser] = await Promise.all([customers.findOne({ _id: winnerId }), customers.findOne({ _id: loserId })]);
  if (!winner || !loser) throw new Error("merge: ไม่พบลูกค้าที่จะรวม");

  const moved = { identities: 0, profiles: 0, interactions: 0, purchases: 0, purchaseItems: 0, intents: 0 };
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const loserIntents = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents)
        .find({ customerId: loserId }, { projection: { courseCode: 1 }, session }).toArray();
      const r1 = await db.collection(COLLECTIONS.identities).updateMany({ customerId: loserId }, { $set: { customerId: winnerId, updatedAt: now } }, { session });
      const r2 = await db.collection(COLLECTIONS.customerProfiles).updateMany({ customerId: loserId }, { $set: { customerId: winnerId } }, { session });
      const r3 = await db.collection(COLLECTIONS.interactions).updateMany({ customerId: loserId }, { $set: { customerId: winnerId } }, { session });
      const r4 = await db.collection(COLLECTIONS.purchases).updateMany(
        { customerId: loserId },
        { $set: { customerId: winnerId, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
        { session }
      );
      const r5 = await db.collection(COLLECTIONS.purchaseItems).updateMany({ customerId: loserId }, { $set: { customerId: winnerId } }, { session });
      const r6 = await db.collection(COLLECTIONS.customerIntents).updateMany(
        { customerId: loserId },
        { $set: { customerId: winnerId, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
        { session }
      );
      await db.collection(COLLECTIONS.partnerEvents).updateMany({ customerId: loserId }, { $set: { customerId: winnerId } }, { session });
      moved.identities = r1.modifiedCount;
      moved.profiles = r2.modifiedCount;
      moved.interactions = r3.modifiedCount;
      moved.purchases = r4.modifiedCount;
      moved.purchaseItems = r5.modifiedCount;
      moved.intents = r6.modifiedCount;

      for (const courseCode of new Set(loserIntents.map((intent) => intent.courseCode))) {
        await recomputeIntentCurrent(db, winnerId, courseCode, now, session);
      }

      // เติม field ที่ winner ยังว่างจาก loser — ไม่ทับของที่มีอยู่แล้ว
      const fill: Record<string, unknown> = {};
      for (const k of FILL_FORWARD) {
        const wv = winner[k];
        const lv = loser[k];
        if ((wv === null || wv === undefined || wv === "") && lv !== null && lv !== undefined && lv !== "") fill[k] = lv;
      }

      await customers.updateOne(
        { _id: winnerId },
        {
          $set: { ...fill, "sheetSync.dirty": true, "aiSync.dirty": true, updatedAt: now },
          ...(loser.firstInteractionAt ? { $min: { firstInteractionAt: loser.firstInteractionAt } } : {}),
          ...(loser.lastInteractionAt ? { $max: { lastInteractionAt: loser.lastInteractionAt } } : {}),
          $addToSet: { sources: { $each: loser.sources ?? [] }, tags: { $each: loser.tags ?? [] } },
          $inc: { "counters.milestones": loser.counters?.milestones ?? 0, "counters.formSubmits": loser.counters?.formSubmits ?? 0 },
        },
        { session }
      );

      await customers.updateOne(
        { _id: loserId },
        { $set: { status: "merged", mergedInto: winnerId, "sheetSync.dirty": true, "aiSync.dirty": true, updatedAt: now } },
        { session }
      );

      const audit: AuditLogDoc = {
        _id: new ObjectId(), actor, action: "customer.merge", customerId: winnerId,
        before: { loserId, loserSources: loser.sources ?? [] },
        after: { winnerId, moved },
        reason, at: now,
      };
      await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne(audit, { session });
    });
  } finally {
    await session.endSession();
  }

  log.info("รวมลูกค้า", { winnerId, loserId, reason, moved });
  return { winnerId, loserId, moved };
}
