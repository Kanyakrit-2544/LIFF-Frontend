import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, getDb } from "../src/db/client";
import { ensureIndexes } from "../src/db/indexes";
import { COLLECTIONS, type AuditLogDoc, type CustomerDoc, type CustomerProfileDoc, type IdentityDoc, type InteractionDoc } from "../src/db/models";
import { newCustomerId } from "../src/ids";
import { ackAiMirror, aiMirrorStats, claimAiMirrorCustomers } from "../src/ai/aiMirror";
import { mergeCustomers } from "../src/identity/merge";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-s9-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let available = false;

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม S9 AI mirror integration test — ตั้ง RUN_MONGO_INTEGRATION=true เพื่อยิง MongoDB จริง\n");
    return;
  }
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  available = true;
}, 30_000);

beforeEach(async () => {
  if (available) await cleanup();
});

afterAll(async () => {
  if (available) await cleanup();
  await closeClient();
});

async function cleanup() {
  const db = await getDb();
  const docs = await db.collection<CustomerDoc>(COLLECTIONS.customers).find({ lineDisplayName: { $regex: `^${runId}` } }).toArray();
  const ids = docs.map((d) => d._id);
  await Promise.all([
    ids.length ? db.collection<CustomerDoc>(COLLECTIONS.customers).deleteMany({ _id: { $in: ids } }) : Promise.resolve(),
    ids.length ? db.collection<IdentityDoc>(COLLECTIONS.identities).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
    ids.length ? db.collection<CustomerProfileDoc>(COLLECTIONS.customerProfiles).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
    ids.length ? db.collection<InteractionDoc>(COLLECTIONS.interactions).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
    ids.length ? db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
  ]);
}

function makeCustomer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  const id = over._id ?? newCustomerId();
  const now = over.updatedAt ?? new Date("2026-08-27T04:00:00Z");
  return {
    _id: id,
    status: "active",
    mergedInto: null,
    title: null, heardFrom: null,
    displayName: "สมชาย ใจดี",
    nickname: "ชาย",
    fullNameEn: "Somchai Jaidee",
    birthYear: 2535,
    lineDisplayName: `${runId}-${id}`,
    pictureUrl: null,
    facebook: null,
    instagram: null,
    phone: "+66812345678",
    email: "somchai@gmail.com",
    customerStatus: "lead",
    tags: ["line-follower"],
    source: { channel: "line", campaign: null },
    sources: ["line"],
    consent: { dataProcessing: true, marketing: false, version: "v1", grantedAt: now, ip: null, userAgent: null },
    profileRef: { revision: 1, formId: "customer_onboarding", formVersion: "v1", updatedAt: now },
    pendingMerge: null,
    sheetSync: { dirty: false, rowKey: id, syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now,
    firstMessageAt: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...over,
  };
}

async function insertCustomer(over: Partial<CustomerDoc> = {}) {
  const doc = makeCustomer(over);
  await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).insertOne(doc);
  return doc;
}

describe.runIf(runIntegration)("S9 AI mirror queue", () => {
  it("claim ส่งเฉพาะ scrubbed customer และ ack ok เคลียร์ dirty", async () => {
    const doc = await insertCustomer();
    const { claimId, rows } = await claimAiMirrorCustomers(10);

    expect(claimId).toMatch(/^job_/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerId).toBe(doc._id);
    expect(rows[0]!.customer.phone).toBe("08x-xxx-5678");
    expect(JSON.stringify(rows[0]!.customer)).not.toContain("+66812345678");
    expect(JSON.stringify(rows[0]!.customer)).not.toContain("somchai@gmail.com");

    const locked = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: doc._id });
    expect(locked?.aiSync.lockedAt).toBeInstanceOf(Date);
    expect(locked?.aiSync.claimId).toBe(claimId);

    const ack = await ackAiMirror([{ customerId: doc._id, status: "ok", claimId }]);
    expect(ack).toEqual({ ok: 1, failed: 0, dead: 0 });
    const after = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: doc._id });
    expect(after?.aiSync.dirty).toBe(false);
    expect(after?.aiSync.syncedAt).toBeInstanceOf(Date);
    expect(after?.aiSync.lockedAt).toBeNull();
    expect(after?.aiSync.attempts).toBe(0);
  });

  it("เรียก claim พร้อมกัน หยิบ customer เดียวได้ครั้งเดียว", async () => {
    await insertCustomer();
    const claims = await Promise.all([claimAiMirrorCustomers(1), claimAiMirrorCustomers(1)]);
    expect(claims.flatMap((c) => c.rows)).toHaveLength(1);
  });

  it("ack error ปลด lock และครบ 5 ครั้งกลายเป็น stuck", async () => {
    const doc = await insertCustomer();
    for (let i = 0; i < 5; i++) {
      const { claimId } = await claimAiMirrorCustomers(10);
      await ackAiMirror([{ customerId: doc._id, status: "error", claimId, error: `round ${i}` }]);
    }
    const after = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: doc._id });
    expect(after?.aiSync.dirty).toBe(true);
    expect(after?.aiSync.lockedAt).toBeNull();
    expect(after?.aiSync.attempts).toBe(5);
    expect(await aiMirrorStats()).toMatchObject({ stuck: 1 });
    expect((await claimAiMirrorCustomers(10)).rows).toHaveLength(0);
  });

  it("ack จาก claim เก่าไม่เคลียร์ dirty ถ้า customer ถูกอัปเดตระหว่าง lock", async () => {
    const doc = await insertCustomer();
    const { claimId } = await claimAiMirrorCustomers(10);
    await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: doc._id },
      { $set: { phone: "+66819999999", updatedAt: new Date(Date.now() + 1_000), "aiSync.dirty": true } }
    );

    const ack = await ackAiMirror([{ customerId: doc._id, status: "ok", claimId }]);
    expect(ack.ok).toBe(0);
    const after = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: doc._id });
    expect(after?.aiSync.dirty).toBe(true);
    expect(after?.aiSync.lockedAt).toBeNull();
  });

  it("merge ตั้ง aiSync.dirty ทั้ง winner/loser และ mirror tombstone ได้", async () => {
    const older = new Date("2026-08-01T00:00:00Z");
    const winner = await insertCustomer({ displayName: "ตัวหลัก", updatedAt: older, createdAt: older, aiSync: { dirty: false, syncedAt: null, lockedAt: null, attempts: 0 } });
    const loser = await insertCustomer({
      title: null, heardFrom: null,
      displayName: "ตัวรอง",
      phone: "+66819999999",
      updatedAt: new Date("2026-08-02T00:00:00Z"),
      createdAt: new Date("2026-08-02T00:00:00Z"),
      aiSync: { dirty: false, syncedAt: null, lockedAt: null, attempts: 0 },
    });

    await mergeCustomers(winner._id, loser._id, "test s9 tombstone", `vitest:${runId}`);

    const db = await getDb();
    const afterWinner = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: winner._id });
    const afterLoser = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: loser._id });
    expect(afterWinner?.aiSync.dirty).toBe(true);
    expect(afterLoser?.status).toBe("merged");
    expect(afterLoser?.mergedInto).toBe(winner._id);
    expect(afterLoser?.aiSync.dirty).toBe(true);

    const rows = (await claimAiMirrorCustomers(10)).rows;
    const loserRow = rows.find((r) => r.customerId === loser._id);
    expect(rows.map((r) => r.customerId)).toEqual(expect.arrayContaining([loser._id, winner._id]));
    expect(loserRow?.customer.status).toBe("merged");
    expect(loserRow?.customer.mergedInto).toBe(winner._id);
  });
});
