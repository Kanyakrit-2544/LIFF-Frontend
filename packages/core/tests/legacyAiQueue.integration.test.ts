import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Filter } from "mongodb";
import { closeClient, getDb } from "../src/db/client";
import { ensureLegacyIndexes } from "../src/legacy/indexes";
import { LEGACY_COLLECTIONS, type LegacyPersonDoc } from "../src/legacy/models";
import { ackLegacyAiSync, claimLegacyAiSync, LEGACY_AI_LEASE_MS, LEGACY_AI_MAX_ATTEMPTS, type LegacyAiSyncDoc } from "../src/legacy/aiQueue";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const prefix = `lgq_${Date.now()}_`;
let available = false;
const queueCollections = [LEGACY_COLLECTIONS.persons, LEGACY_COLLECTIONS.payments, LEGACY_COLLECTIONS.enrollments] as const;

function person(id: string, over: Partial<LegacyPersonDoc> = {}): LegacyPersonDoc {
  const now = new Date("2026-08-28T00:00:00Z");
  return {
    _id: id,
    fullNameTh: "สมชาย ใจดี",
    fullNameEn: null,
    nickname: null,
    phone: null,
    email: null,
    socialHandle: null,
    ageAtImport: null,
    firstPaidAt: now,
    lastPaidAt: now,
    totalPaid: 100,
    paymentCount: 1,
    seatCount: 1,
    courseCodes: ["INNER"],
    sourceRefs: [],
    synthetic: true,
    importRunId: "job_test",
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    ...over,
  };
}

beforeAll(async () => {
  if (!runIntegration) return;
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureLegacyIndexes(db);
  available = true;
}, 30_000);

beforeEach(async () => {
  if (!available) return;
  const db = await getDb();
  await Promise.all(queueCollections.map((name) =>
    db.collection<LegacyAiSyncDoc>(name).deleteMany({ _id: { $regex: `^${prefix}` } } as Filter<LegacyAiSyncDoc>)
  ));
});

afterAll(async () => {
  if (available) {
    const db = await getDb();
    await Promise.all(queueCollections.map((name) =>
      db.collection<LegacyAiSyncDoc>(name).deleteMany({ _id: { $regex: `^${prefix}` } } as Filter<LegacyAiSyncDoc>)
    ));
  }
  await closeClient();
});

describe.runIf(runIntegration)("legacy AI queue", () => {
  it("ack claimId ไม่ตรงไม่เคลียร์ dirty", async () => {
    const db = await getDb();
    const doc = person(`${prefix}wrong-claim`);
    await db.collection(LEGACY_COLLECTIONS.persons).insertOne(doc as never);
    const claim = await claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 10);
    await ackLegacyAiSync(db, LEGACY_COLLECTIONS.persons, [{ _id: doc._id, claimId: "job_wrong", status: "ok" }]);
    const after = await db.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons).findOne({ _id: doc._id });
    expect(after?.aiSync.dirty).toBe(true);
    expect(after?.aiSync.claimId).toBe(claim.claimId);
  });

  it("attempts ครบ 5 แล้วไม่ถูก claim อีก", async () => {
    const db = await getDb();
    const doc = person(`${prefix}dead`);
    await db.collection(LEGACY_COLLECTIONS.persons).insertOne(doc as never);
    for (let i = 0; i < LEGACY_AI_MAX_ATTEMPTS; i++) {
      const claim = await claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 10);
      expect(claim.rows).toHaveLength(1);
      await ackLegacyAiSync(db, LEGACY_COLLECTIONS.persons, [{ _id: doc._id, claimId: claim.claimId, status: "error" }]);
    }
    const last = await claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 10);
    expect(last.rows).toHaveLength(0);
  });

  it("claim ซ้อนกันไม่หยิบ document เดียวกัน", async () => {
    const db = await getDb();
    await db.collection(LEGACY_COLLECTIONS.persons).insertOne(person(`${prefix}concurrent`) as never);
    const claims = await Promise.all([
      claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 1),
      claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 1),
    ]);
    expect(claims.flatMap((claim) => claim.rows)).toHaveLength(1);
  });

  it("ปลด lock เก่ากว่า lease แล้ว claim ใหม่ได้", async () => {
    const db = await getDb();
    const old = new Date(Date.now() - LEGACY_AI_LEASE_MS - 1_000);
    await db.collection(LEGACY_COLLECTIONS.persons).insertOne(person(`${prefix}stale`, { aiSync: { dirty: true, syncedAt: null, lockedAt: old, attempts: 0, claimId: "job_old" } }) as never);
    const claim = await claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 10);
    expect(claim.rows).toHaveLength(1);
  });

  it("payment และ enrollment ใช้ claim/ack ได้ด้วย updatedAt", async () => {
    const db = await getDb();
    const now = new Date("2026-08-28T00:00:00Z");
    for (const name of [LEGACY_COLLECTIONS.payments, LEGACY_COLLECTIONS.enrollments]) {
      const doc: LegacyAiSyncDoc = {
        _id: `${prefix}${name}`,
        updatedAt: now,
        aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
      };
      await db.collection<LegacyAiSyncDoc>(name).insertOne(doc);
      const claim = await claimLegacyAiSync<LegacyAiSyncDoc>(db, name, 10);
      expect(claim.rows).toHaveLength(1);
      expect(await ackLegacyAiSync(db, name, [{ _id: doc._id, claimId: claim.claimId, status: "ok" }]))
        .toEqual({ ok: 1, failed: 0, dead: 0 });
      expect((await db.collection<LegacyAiSyncDoc>(name).findOne({ _id: doc._id }))?.aiSync.dirty).toBe(false);
    }
  });

  it("ข้อมูลที่เปลี่ยนหลัง claim ยัง dirty เพื่อให้ sync รอบใหม่", async () => {
    const db = await getDb();
    const doc = person(`${prefix}changed-after-claim`);
    await db.collection(LEGACY_COLLECTIONS.persons).insertOne(doc as never);
    const claim = await claimLegacyAiSync<LegacyPersonDoc>(db, LEGACY_COLLECTIONS.persons, 10);
    await db.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons).updateOne(
      { _id: doc._id },
      { $set: { updatedAt: new Date(Date.now() + 1_000), "aiSync.dirty": true } }
    );
    expect((await ackLegacyAiSync(db, LEGACY_COLLECTIONS.persons, [{ _id: doc._id, claimId: claim.claimId, status: "ok" }])).ok).toBe(0);
    const after = await db.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons).findOne({ _id: doc._id });
    expect(after?.aiSync.dirty).toBe(true);
    expect(after?.aiSync.lockedAt).toBeNull();
  });
});
