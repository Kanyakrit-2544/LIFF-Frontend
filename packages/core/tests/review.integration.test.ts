import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import {
  AI_COLLECTIONS,
  COLLECTIONS,
  assignPartnerIdentity,
  closeClient,
  confirmPendingMerge,
  correctPartnerEvent,
  decideCustomerLink,
  ensureIndexes,
  getDb,
  intakePartnerEvents,
  isMergePairRejected,
  rejectPartnerEvent,
  rejectPendingMerge,
  resolveCustomer,
  type AuditLogDoc,
  type CustomerDoc,
  type CustomerLinkDoc,
  type PartnerEventDoc,
  type PurchaseDoc,
} from "../src";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `review_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const actor = `staff:${runId}@example.test`;
let db: Db;
const customerIds: string[] = [];

async function customer(label: string, phone: string | null = null): Promise<CustomerDoc> {
  const resolved = await resolveCustomer({
    provider: "line", channelId: "review-test", externalId: `${runId}_${label}`,
    verified: true, create: { sourceChannel: "test" },
  });
  customerIds.push(resolved.customerId);
  await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
    { _id: resolved.customerId }, { $set: { displayName: label, phone } }
  );
  return (await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: resolved.customerId }))!;
}

async function cleanup(): Promise<void> {
  const purchases = await db.collection<PurchaseDoc>(COLLECTIONS.purchases).find({ partnerId: runId }).toArray();
  await Promise.all([
    db.collection(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: { $in: purchases.map((row) => row._id) } }),
    db.collection(COLLECTIONS.purchases).deleteMany({ partnerId: runId }),
    db.collection(COLLECTIONS.customerIntents).deleteMany({ partnerId: runId }),
    db.collection(COLLECTIONS.partnerEvents).deleteMany({ partnerId: runId }),
    db.collection(COLLECTIONS.partnerQuarantine).deleteMany({ partnerId: runId }),
    db.collection(COLLECTIONS.auditLogs).deleteMany({ actor }),
    db.collection(COLLECTIONS.staffReviewDecisions).deleteMany({ actor }),
    db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).deleteMany({ _id: { $regex: `^${runId}` } }),
    db.collection<{ externalId: string }>(COLLECTIONS.identities).deleteMany({ externalId: { $regex: `^${runId}` } }),
    customerIds.length ? db.collection<CustomerDoc>(COLLECTIONS.customers).deleteMany({ _id: { $in: customerIds } }) : Promise.resolve(),
  ]);
}

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
}, 30_000);

afterAll(async () => {
  if (runIntegration) await cleanup();
  await closeClient();
});

describe.runIf(runIntegration)("staff review", () => {
  it("ปฏิเสธ pending merge แล้วจำคู่นี้ถาวรและเขียน audit", async () => {
    const left = await customer("merge-left", "+66811110001");
    const right = await customer("merge-right", "+66811110001");
    await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: left._id }, { $set: { pendingMerge: { candidateId: right._id, reason: "phone_match", at: new Date() } } }
    );
    await rejectPendingMerge({ customerId: left._id, candidateId: right._id, actor, reason: "คนละคน" });
    expect(await isMergePairRejected(db, left._id, right._id)).toBe(true);
    expect((await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: left._id }))?.pendingMerge).toBeNull();
    expect(await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).countDocuments({ actor, action: "customer.merge_rejected" })).toBe(1);
  });

  it("⭐ ปฏิเสธแล้วธงต้องไม่กลับมาอีก แม้เจอเบอร์ตรงกันซ้ำ (สิ่งที่พนักงานจะเจอจริง)", async () => {
    const phone = "+66811119999";
    const left = await customer("recur-left", phone);
    const right = await customer("recur-right", phone);
    await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: left._id }, { $set: { pendingMerge: { candidateId: right._id, reason: "phone_match", at: new Date() } } }
    );
    await rejectPendingMerge({ customerId: left._id, candidateId: right._id, actor, reason: "คนละคน" });

    // จำลองรอบใหม่: ลูกค้าคนเดิมกรอกเบอร์เดิมเข้ามาอีก
    // โค้ดที่ตั้งธง (applyFormSubmission / upsertFromLead) ต้องถาม isMergePairRejected ก่อนเสมอ
    const shouldFlagAgain = !(await isMergePairRejected(db, left._id, right._id));
    expect(shouldFlagAgain, "คู่ที่พนักงานปฏิเสธแล้วต้องไม่ถูกตั้งธงซ้ำ").toBe(false);

    // และคู่อื่นที่ยังไม่เคยตัดสิน ต้องยังตั้งธงได้ตามปกติ
    const other = await customer("recur-other", phone);
    expect(await isMergePairRejected(db, left._id, other._id)).toBe(false);
  });

  it("ยืนยัน pending merge ผ่าน transaction เดิมและมี audit ของพนักงาน", async () => {
    const left = await customer("confirm-left", "+66811110002");
    const right = await customer("confirm-right", "+66811110002");
    await db.collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: left._id }, { $set: { pendingMerge: { candidateId: right._id, reason: "phone_match", at: new Date() } } }
    );
    const result = await confirmPendingMerge({ customerId: left._id, candidateId: right._id, actor });
    expect(result.winnerId).not.toBe(result.loserId);
    expect((await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: result.loserId }))?.status).toBe("merged");
    expect(await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).countDocuments({ actor, action: "customer.merge" })).toBe(1);
  });

  it("ตัดสิน customer link แล้วเขียน audit โดยพนักงาน", async () => {
    const current = await customer("link-customer");
    const now = new Date();
    const link: CustomerLinkDoc = {
      _id: `${runId}_link`, customerId: current._id, legacyPersonId: `${runId}_legacy`,
      method: "phone_hash", confidence: "medium", score: 0.8, status: "needs_review",
      evidence: { phoneHashMatch: true, emailHashMatch: false, nameKeyOverlap: 1, nicknameMatch: false, ageBandMatch: null, competingCandidates: 1 },
      decidedBy: "rule", decidedAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
    };
    await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).insertOne(link);
    await decideCustomerLink({ mainDb: db, aiDb: db, linkId: link._id, decision: "confirmed", actor });
    expect(await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).findOne({ _id: link._id })).toMatchObject({ status: "confirmed", decidedBy: "staff" });
    expect(await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).countDocuments({ actor, action: "customer_link.confirmed" })).toBe(1);
  });

  it("แก้ quarantine แล้วเพิ่ม revision และผูก pending identity ด้วยมือได้", async () => {
    const eventId = `${runId}_purchase`;
    const raw = {
      eventId, type: "purchase", occurredAt: "2026-08-31T10:00:00+07:00", revision: 1,
      subject: { fullName: "ลูกค้าที่ยังไม่รู้ตัว" },
      payment: { externalPaymentId: null, amount: 500, currency: "THB", paidAt: "2026-08-31", saleRep: null, lines: [{ courseLabel: "คอร์สไม่รู้จัก", courseCode: null, kind: "enrolled" }] },
    };
    expect((await intakePartnerEvents(runId, [raw])).results[0]?.status).toBe("quarantined");
    const corrected = await correctPartnerEvent({
      partnerId: runId, eventId, actor,
      correction: { purchaseLines: [{ index: 0, courseLabel: "Inner", courseCode: "INNER" }] },
    });
    expect(corrected.status).toBe("pending_identity");
    expect((await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne({ partnerId: runId, eventId }))?.revision).toBe(2);
    const target = await customer("partner-target");
    await assignPartnerIdentity({ partnerId: runId, eventId, customerId: target._id, actor });
    expect(await db.collection<PurchaseDoc>(COLLECTIONS.purchases).findOne({ partnerId: runId, sourceEventId: eventId })).toMatchObject({ customerId: target._id });
    expect(await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).countDocuments({ actor, action: "partner_event.identity_confirmed" })).toBe(1);
  });

  it("ปฏิเสธ partner event แล้วไม่กลับเข้าคิวตรวจ", async () => {
    const eventId = `${runId}_tag`;
    await intakePartnerEvents(runId, [{ eventId, type: "tag", occurredAt: "2026-08-31T10:00:00+07:00", revision: 1, tags: ["x"] }]);
    await rejectPartnerEvent({ partnerId: runId, eventId, actor, reason: "ไม่รองรับ" });
    expect(await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne({ partnerId: runId, eventId })).toMatchObject({ status: "rejected" });
  });
});
