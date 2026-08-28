import type { Db } from "mongodb";
import { LEGACY_COLLECTIONS } from "./models";

/**
 * index ของฐาน legacy — ตั้งตามคำถามที่ analytics จะถามจริง
 * "คอร์สไหน ช่วงไหน กี่คน ยอดเท่าไร มาจากเซลคนไหน" + การจับคู่กับลูกค้า LINE ด้วยเบอร์/อีเมล
 */
export const LEGACY_INDEXES: Record<string, { name: string; key: Record<string, 1 | -1>; unique?: boolean; sparse?: boolean }[]> = {
  [LEGACY_COLLECTIONS.persons]: [
    { name: "ix_phone", key: { phone: 1 }, sparse: true },
    { name: "ix_email", key: { email: 1 }, sparse: true },
    { name: "ix_importRun", key: { importRunId: 1 } },
    { name: "ix_lastPaid", key: { lastPaidAt: -1 } },
    { name: "ix_aiSyncQueue", key: { "aiSync.dirty": 1, "aiSync.lockedAt": 1 } },
  ],
  [LEGACY_COLLECTIONS.payments]: [
    { name: "ix_person", key: { personId: 1 } },
    { name: "ix_paidAt", key: { paidAt: 1 } },
    { name: "ix_slip", key: { slipNo: 1 } },
    { name: "ix_yearRep", key: { year: 1, saleRep: 1 } },
    { name: "ix_aiSyncQueue", key: { "aiSync.dirty": 1, "aiSync.lockedAt": 1 } },
  ],
  [LEGACY_COLLECTIONS.enrollments]: [
    { name: "ix_person", key: { personId: 1 } },
    { name: "ix_payment", key: { paymentId: 1 } },
    // คำถามหลัก: คอร์สนี้ในช่วงเวลานี้ ขายได้กี่ที่นั่ง
    { name: "ix_courseSession", key: { courseCode: 1, sessionStart: 1, countsAsSeat: 1 } },
    { name: "ix_aiSyncQueue", key: { "aiSync.dirty": 1, "aiSync.lockedAt": 1 } },
  ],
  [LEGACY_COLLECTIONS.importRuns]: [{ name: "ix_startedAt", key: { startedAt: -1 } }],
};

export async function ensureLegacyIndexes(db: Db): Promise<{ collection: string; created: string[] }[]> {
  const out: { collection: string; created: string[] }[] = [];
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, specs] of Object.entries(LEGACY_INDEXES)) {
    if (!existing.has(name)) await db.createCollection(name);
    const created: string[] = [];
    for (const spec of specs) {
      // ส่งเฉพาะ option ที่กำหนดจริง — MongoDB ปฏิเสธ unique: null
      await db.collection(name).createIndex(spec.key, {
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
        ...(spec.sparse ? { sparse: true } : {}),
      });
      created.push(spec.name);
    }
    out.push({ collection: name, created });
  }
  return out;
}
