import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Filter } from "mongodb";
import { closeClient, getDb } from "../src/db/client";
import { COLLECTIONS, type CustomerDoc, type IdentityDoc } from "../src/db/models";
import { ensureIndexes } from "../src/db/indexes";
import { resolveCustomer } from "../src/identity/resolve";
import { mergeCustomers } from "../src/identity/merge";
import { normalizePhone } from "../src/identity/normalize";
import { intakePartnerEvents } from "../src/partner/intake";
import type { CustomerIntentDoc, PartnerEventDoc, PurchaseDoc, PurchaseItemDoc } from "../src/partner/models";
import { reconcilePartnerIdentities } from "../src/partner/reconcile";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `m35_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const partnerId = runId;
let available = false;
const extraCustomerIds = new Set<string>();

function eventId(value: string) {
  return `${runId}_${value}`;
}

function subjectLine(value = "customer") {
  return { lineUserId: `${runId}_${value}` };
}

function purchase(id: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: eventId(id), type: "purchase", occurredAt: "2026-08-28T10:00:00+07:00", revision: 1,
    subject: { fullName: "ผู้ซื้อทดสอบ" },
    payment: {
      externalPaymentId: `pay-${id}`, amount: 15000, currency: "THB", paidAt: "2026-08-28", saleRep: "Test",
      lines: [
        { courseLabel: "Inner", kind: "enrolled", countsAsSeat: false },
        { courseLabel: "Communication", kind: "relearn", countsAsSeat: true },
        { courseLabel: "Presentation", kind: "free", countsAsSeat: true },
      ],
    },
    ...overrides,
  };
}

function intent(id: string, occurredAt: string, source: "ai" | "staff", overrides: Record<string, unknown> = {}) {
  return {
    eventId: eventId(id), type: "intent", occurredAt, revision: 1, subject: subjectLine(),
    intent: {
      courseCode: "INNER", status: "interested", hesitationReason: null,
      confidence: source === "ai" ? 0.8 : 0.5, source, model: source === "ai" ? "test-model" : null,
    },
    ...overrides,
  };
}

async function cleanup() {
  const db = await getDb();
  const purchases = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
    .find({ partnerId }, { projection: { _id: 1 } }).toArray();
  const identities = await db.collection<IdentityDoc>(COLLECTIONS.identities)
    .find({ externalId: { $regex: `^${runId}` } } as Filter<IdentityDoc>, { projection: { customerId: 1 } }).toArray();
  const customerIds = [...new Set([...identities.map((row) => row.customerId), ...extraCustomerIds])];
  await Promise.all([
    db.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: { $in: purchases.map((row) => row._id) } }),
    db.collection<PurchaseDoc>(COLLECTIONS.purchases).deleteMany({ partnerId }),
    db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).deleteMany({ partnerId }),
    db.collection<{ partnerId: string }>(COLLECTIONS.partnerQuarantine).deleteMany({ partnerId }),
    db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).deleteMany({ partnerId }),
    db.collection<IdentityDoc>(COLLECTIONS.identities).deleteMany({ externalId: { $regex: `^${runId}` } }),
    db.collection(COLLECTIONS.auditLogs).deleteMany({ actor: runId }),
  ]);
  if (customerIds.length > 0) await db.collection<CustomerDoc>(COLLECTIONS.customers).deleteMany({ _id: { $in: customerIds } });
  extraCustomerIds.clear();
}

beforeAll(async () => {
  if (!runIntegration) return;
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

describe.runIf(runIntegration)("S11-M3.5 partner intake", () => {
  it("event เดิมพร้อมกัน 10 ครั้งสร้าง 1 purchase และ 3 items โดยยอดไม่คูณ", async () => {
    const payload = purchase("same-ten");
    const reports = await Promise.all(Array.from({ length: 10 }, () => intakePartnerEvents(partnerId, [payload])));
    expect(reports.flatMap((report) => report.results).filter((row) => row.status !== "duplicate")).toHaveLength(1);

    const db = await getDb();
    const rows = await db.collection<PurchaseDoc>(COLLECTIONS.purchases).find({ partnerId }).toArray();
    const items = await db.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems).find({ purchaseId: rows[0]!._id }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(15000);
    expect(items).toHaveLength(3);
    expect(items.map((row) => row.countsAsSeat)).toEqual([true, false, false]);
    expect(items.every((row) => !("amount" in row))).toBe(true);
  }, 30_000);

  it("course ไม่รู้จักเข้า quarantine แต่ event ดีในชุดเดียวกันยังถูกบันทึก", async () => {
    const bad = purchase("bad-course", {
      payment: { externalPaymentId: null, amount: 1, currency: "THB", paidAt: null, saleRep: null,
        lines: [{ courseLabel: "คอร์สที่ไม่มี", kind: "enrolled" }] },
    });
    const report = await intakePartnerEvents(partnerId, [bad, purchase("good-course")]);
    expect(report.summary).toMatchObject({ quarantined: 1, pendingIdentity: 1 });
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.partnerQuarantine).countDocuments({ partnerId, eventId: eventId("bad-course") })).toBe(1);
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({ partnerId })).toBe(1);
  });

  it("revision ต่ำไม่ทับข้อมูล และ purchase.void ไม่ลบรายการ", async () => {
    await intakePartnerEvents(partnerId, [purchase("revision", { revision: 2 })]);
    const changedOwner = await intakePartnerEvents(partnerId, [purchase("revision", {
      revision: 3,
      subject: subjectLine("revision-owner-change"),
    })]);
    expect(changedOwner.results[0]).toMatchObject({ status: "rejected", reason: "revision_identity_change" });
    const duplicate = await intakePartnerEvents(partnerId, [purchase("revision", {
      revision: 1,
      payment: { externalPaymentId: "changed", amount: 1, currency: "THB", paidAt: null, saleRep: null,
        lines: [{ courseLabel: "Inner", kind: "enrolled" }] },
    })]);
    expect(duplicate.results[0]?.status).toBe("duplicate");
    await intakePartnerEvents(partnerId, [{
      eventId: eventId("revision-void"), type: "purchase.void", occurredAt: "2026-08-29T10:00:00+07:00",
      revision: 1, voids: eventId("revision"),
    }]);
    const db = await getDb();
    const row = await db.collection<PurchaseDoc>(COLLECTIONS.purchases).findOne({ partnerId, sourceEventId: eventId("revision") });
    expect(row).toMatchObject({ amount: 15000, status: "voided" });
  });

  it("staff soft ถูก AI ที่ใหม่กว่าทับได้ และ event เก่าที่มาทีหลังไม่เป็นปัจจุบัน", async () => {
    const reports = [];
    reports.push(await intakePartnerEvents(partnerId, [intent("ai-1", "2026-06-01T10:00:00+07:00", "ai")]));
    reports.push(await intakePartnerEvents(partnerId, [intent("staff", "2026-07-01T10:00:00+07:00", "staff")]));
    reports.push(await intakePartnerEvents(partnerId, [intent("ai-2", "2026-08-01T10:00:00+07:00", "ai")]));
    reports.push(await intakePartnerEvents(partnerId, [intent("late-old", "2026-05-01T10:00:00+07:00", "ai")]));
    expect(reports.map((row) => row.results[0]?.status)).toEqual(["accepted", "accepted", "accepted", "accepted"]);

    const rows = await (await getDb()).collection<CustomerIntentDoc>(COLLECTIONS.customerIntents)
      .find({ partnerId }).sort({ observedAt: 1 }).toArray();
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(rows.find((row) => row.supersededAt === null)?.sourceEventId).toBe(eventId("ai-2"));
    expect(rows.find((row) => row.sourceEventId === eventId("staff"))).toMatchObject({ confidence: 1, belowThreshold: false });
  });

  it("AI ที่เก่ากว่า staff ถูกปฏิเสธ และ sticky กัน AI แต่ staff ใหม่ยังทับได้", async () => {
    await intakePartnerEvents(partnerId, [intent("staff-soft", "2026-07-01T10:00:00+07:00", "staff")]);
    const oldAi = await intakePartnerEvents(partnerId, [intent("ai-old", "2026-06-01T10:00:00+07:00", "ai")]);
    expect(oldAi.results[0]).toMatchObject({ status: "rejected", reason: "staff_decided" });
    await intakePartnerEvents(partnerId, [intent("staff-sticky", "2026-08-01T10:00:00+07:00", "staff", {
      intent: { courseCode: "INNER", status: "interested", hesitationReason: null, confidence: 0.2, source: "staff", model: null, lock: "sticky" },
    })]);
    const blocked = await intakePartnerEvents(partnerId, [intent("ai-new", "2027-01-01T10:00:00+07:00", "ai")]);
    expect(blocked.results[0]).toMatchObject({ status: "rejected", reason: "staff_sticky" });
    const staff = await intakePartnerEvents(partnerId, [intent("staff-new", "2027-02-01T10:00:00+07:00", "staff")]);
    expect(staff.results[0]?.status).toBe("accepted");
    expect(await (await getDb()).collection(COLLECTIONS.customerIntents).countDocuments({ partnerId })).toBe(3);
  });

  it("intent.void เก็บประวัติและคืนตัวปัจจุบันเป็นแถวก่อนหน้า", async () => {
    await intakePartnerEvents(partnerId, [intent("intent-before", "2026-06-01T10:00:00+07:00", "ai")]);
    await intakePartnerEvents(partnerId, [intent("intent-current", "2026-07-01T10:00:00+07:00", "ai")]);
    await intakePartnerEvents(partnerId, [{
      eventId: eventId("intent-void"), type: "intent.void", occurredAt: "2026-08-01T10:00:00+07:00",
      revision: 1, voids: eventId("intent-current"),
    }]);
    const rows = await (await getDb()).collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({ partnerId }).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.sourceEventId === eventId("intent-current"))?.voidedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.supersededAt === null)?.sourceEventId).toBe(eventId("intent-before"));
  });

  it("tag เข้า quarantine และไม่แก้ customers.tags", async () => {
    await intakePartnerEvents(partnerId, [intent("make-customer", "2026-06-01T10:00:00+07:00", "ai")]);
    const db = await getDb();
    const identity = await db.collection<IdentityDoc>(COLLECTIONS.identities).findOne({ externalId: subjectLine().lineUserId });
    const before = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: identity!.customerId });
    const report = await intakePartnerEvents(partnerId, [{
      eventId: eventId("tag"), type: "tag", occurredAt: "2026-08-01T10:00:00+07:00", revision: 1,
      subject: subjectLine(), tags: ["vip"],
    }]);
    const after = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: identity!.customerId });
    expect(report.results[0]).toMatchObject({ status: "quarantined", reason: "unsupported_type:tag" });
    expect(after?.tags).toEqual(before?.tags);
  });

  it("phone ตรงสองคนยัง pending และ reconciliation ไม่เดา", async () => {
    const phone = normalizePhone("0812345678")!;
    for (const suffix of ["amb-a", "amb-b"]) {
      const resolved = await resolveCustomer({ provider: "line", channelId: "test", externalId: `${runId}_${suffix}` });
      await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne({ _id: resolved.customerId }, { $set: { phone } });
    }
    const report = await intakePartnerEvents(partnerId, [purchase("ambiguous", { subject: { phone } })]);
    expect(report.results[0]).toMatchObject({ status: "pending_identity", reason: "ambiguous_identity" });
    const reconciled = await reconcilePartnerIdentities(await getDb());
    expect(reconciled.ambiguous).toBe(1);
    expect(await (await getDb()).collection(COLLECTIONS.purchases).countDocuments({ partnerId, customerId: null })).toBe(1);
  });

  it("reconcile จับเจ้าของย้อนหลังและคำนวณสาย intent ใหม่แบบรันซ้ำได้", async () => {
    const phone = normalizePhone("0898765432")!;
    const unresolvedSubject = { phone };
    await intakePartnerEvents(partnerId, [intent("unresolved-new", "2026-08-01T10:00:00+07:00", "ai", { subject: unresolvedSubject })]);
    await intakePartnerEvents(partnerId, [intent("unresolved-old", "2026-07-01T10:00:00+07:00", "ai", { subject: unresolvedSubject })]);
    const resolved = await resolveCustomer({ provider: "line", channelId: "test", externalId: `${runId}_reconcile` });
    await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne({ _id: resolved.customerId }, { $set: { phone } });

    const first = await reconcilePartnerIdentities(await getDb());
    const second = await reconcilePartnerIdentities(await getDb());
    const rows = await (await getDb()).collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({ partnerId }).toArray();
    expect(first).toMatchObject({ scanned: 2, resolved: 2 });
    expect(second).toEqual({ scanned: 0, resolved: 0, stillPending: 0, ambiguous: 0 });
    expect(rows.every((row) => row.customerId === resolved.customerId)).toBe(true);
    expect(rows.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(rows.find((row) => row.supersededAt === null)?.sourceEventId).toBe(eventId("unresolved-new"));
  });

  it("100 events สองรอบคงเหลือ 100 purchases", async () => {
    const events = Array.from({ length: 100 }, (_, index) => purchase(`bulk-${index}`, {
      payment: { externalPaymentId: null, amount: 100 + index, currency: "THB", paidAt: "2026-08-28", saleRep: null,
        lines: [{ courseLabel: "Inner", kind: "enrolled" }] },
    }));
    const first = await intakePartnerEvents(partnerId, events);
    const second = await intakePartnerEvents(partnerId, events);
    expect(first.summary.pendingIdentity).toBe(100);
    expect(second.summary.duplicate).toBe(100);
    expect(await (await getDb()).collection(COLLECTIONS.purchases).countDocuments({ partnerId })).toBe(100);
  }, 60_000);

  it("lineUserId ใหม่สร้าง customer และ identity เพียงชุดเดียว", async () => {
    const report = await intakePartnerEvents(partnerId, [intent("new-line", "2026-08-01T10:00:00+07:00", "ai", {
      subject: subjectLine("brand-new"),
    })]);
    expect(report.results[0]?.status).toBe("accepted");
    const db = await getDb();
    const identity = await db.collection<IdentityDoc>(COLLECTIONS.identities).findOne({ externalId: subjectLine("brand-new").lineUserId });
    expect(identity).toMatchObject({ provider: "line", verified: true });
    expect(await db.collection<CustomerDoc>(COLLECTIONS.customers).countDocuments({ _id: identity!.customerId })).toBe(1);
  });

  it("merge ย้าย purchase/intent ไปผู้ชนะและคำนวณ intent ปัจจุบันใหม่", async () => {
    await intakePartnerEvents(partnerId, [intent("merge-winner", "2026-06-01T10:00:00+07:00", "ai", {
      subject: subjectLine("merge-winner"),
    })]);
    await intakePartnerEvents(partnerId, [intent("merge-loser", "2026-08-01T10:00:00+07:00", "ai", {
      subject: subjectLine("merge-loser"),
    })]);
    await intakePartnerEvents(partnerId, [purchase("merge-purchase", { subject: subjectLine("merge-loser") })]);
    const db = await getDb();
    const winner = await db.collection<IdentityDoc>(COLLECTIONS.identities)
      .findOne({ externalId: subjectLine("merge-winner").lineUserId });
    const loser = await db.collection<IdentityDoc>(COLLECTIONS.identities)
      .findOne({ externalId: subjectLine("merge-loser").lineUserId });
    extraCustomerIds.add(winner!.customerId);
    extraCustomerIds.add(loser!.customerId);

    const result = await mergeCustomers(winner!.customerId, loser!.customerId, "M3.5 integration", runId);
    const intents = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({ partnerId }).toArray();
    const purchaseRow = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
      .findOne({ partnerId, sourceEventId: eventId("merge-purchase") });
    expect(result.moved).toMatchObject({ purchases: 1, purchaseItems: 3, intents: 1 });
    expect(intents.every((row) => row.customerId === winner!.customerId)).toBe(true);
    expect(intents.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(intents.find((row) => row.supersededAt === null)?.sourceEventId).toBe(eventId("merge-loser"));
    expect(purchaseRow?.customerId).toBe(winner!.customerId);
  });
});
