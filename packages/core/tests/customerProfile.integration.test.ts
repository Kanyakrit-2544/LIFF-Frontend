import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AI_COLLECTIONS,
  COLLECTIONS,
  closeClient,
  getClient,
  getCustomerProfile,
  type CustomerDoc,
  type CustomerLinkDoc,
} from "../src";
import { LEGACY_COLLECTIONS } from "../src/legacy/models";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `m5_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let client: MongoClient;
let mainDb: Db;
let aiDb: Db;
let legacyDb: Db;

function customer(id: string, status: CustomerDoc["status"] = "active"): CustomerDoc {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    _id: id,
    status,
    mergedInto: null,
    title: null,
    heardFrom: "Facebook",
    displayName: `ลูกค้า ${id}`,
    nickname: null,
    fullNameEn: null,
    birthYear: null,
    lineDisplayName: `LINE ${id}`,
    pictureUrl: null,
    facebook: null,
    instagram: null,
    phone: "+66812345678",
    email: `${id}@example.test`,
    customerStatus: "customer",
    tags: [],
    source: { channel: "test", campaign: null },
    sources: ["test"],
    consent: null,
    profileRef: null,
    pendingMerge: null,
    sheetSync: { dirty: false, rowKey: id, syncedAt: now, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now,
    firstMessageAt: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

function link(id: string, customerId: string, legacyPersonId: string, status: CustomerLinkDoc["status"]): CustomerLinkDoc {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    _id: id,
    customerId,
    legacyPersonId,
    method: "phone_hash",
    confidence: "high",
    score: 1,
    status,
    evidence: {
      phoneHashMatch: true,
      emailHashMatch: false,
      nameKeyOverlap: 0,
      nicknameMatch: false,
      ageBandMatch: null,
      competingCandidates: 0,
    },
    decidedBy: status === "confirmed" ? "staff" : "rule",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

async function addLegacyPayment(input: {
  id: string;
  personId: string;
  amount: number;
  paidAt: string;
  courses: Array<{ code: string; kind?: string; countsAsSeat?: boolean }>;
}): Promise<void> {
  const now = new Date("2026-08-01T00:00:00.000Z");
  await legacyDb.collection(LEGACY_COLLECTIONS.payments).insertOne({
    _id: input.id,
    personId: input.personId,
    slipNo: null,
    slipShared: false,
    amount: input.amount,
    paidAt: new Date(input.paidAt),
    year: new Date(input.paidAt).getUTCFullYear(),
    saleRep: "Legacy Staff",
    source: { sheet: "test", row: 1 },
    synthetic: false,
    importRunId: runId,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
  } as never);
  if (input.courses.length) {
    await legacyDb.collection(LEGACY_COLLECTIONS.enrollments).insertMany(input.courses.map((item, index) => ({
      _id: `${input.id}_course_${index}`,
      personId: input.personId,
      paymentId: input.id,
      courseCode: item.code,
      courseLabel: item.code,
      kind: item.kind ?? "enrolled",
      countsAsSeat: item.countsAsSeat ?? true,
      sessionLabel: null,
      sessionStart: null,
      sessionPrecision: "none",
      sessionYear: null,
      refSlip: null,
      substitute: false,
      raw: "test",
      source: { sheet: "test", row: 1 },
      synthetic: false,
      importRunId: runId,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
    })) as never[]);
  }
}

async function addPartnerPayment(input: {
  id: string;
  customerId: string;
  amount: number;
  paidAt: string;
  courses: Array<{ code: string; kind?: string; countsAsSeat?: boolean }>;
}): Promise<void> {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const paidAt = new Date(input.paidAt);
  await mainDb.collection(COLLECTIONS.purchases).insertOne({
    _id: input.id,
    customerId: input.customerId,
    partnerId: runId,
    externalPaymentId: null,
    amount: input.amount,
    currency: "THB",
    paidAt,
    year: paidAt.getUTCFullYear(),
    month: paidAt.getUTCMonth() + 1,
    saleRep: "Partner Staff",
    attribution: null,
    status: "active",
    sourceEventId: `${input.id}_event`,
    aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  } as never);
  if (input.courses.length) {
    await mainDb.collection(COLLECTIONS.purchaseItems).insertMany(input.courses.map((item, index) => ({
      _id: `${input.id}_course_${index}`,
      purchaseId: input.id,
      customerId: input.customerId,
      courseCode: item.code,
      courseLabel: item.code,
      kind: item.kind ?? "enrolled",
      countsAsSeat: item.countsAsSeat ?? true,
      sessionLabel: null,
      sessionStart: null,
      sessionYear: null,
      createdAt: now,
      schemaVersion: 1,
    })) as never[]);
  }
}

async function clear(): Promise<void> {
  await Promise.all([
    mainDb.collection(COLLECTIONS.customers).deleteMany({}),
    mainDb.collection(COLLECTIONS.purchases).deleteMany({}),
    mainDb.collection(COLLECTIONS.purchaseItems).deleteMany({}),
    aiDb.collection(AI_COLLECTIONS.customerLinks).deleteMany({}),
    legacyDb.collection(LEGACY_COLLECTIONS.payments).deleteMany({}),
    legacyDb.collection(LEGACY_COLLECTIONS.enrollments).deleteMany({}),
  ]);
}

beforeAll(async () => {
  if (!runIntegration) return;
  client = await getClient();
  mainDb = client.db(`${runId}_main`);
  aiDb = client.db(`${runId}_ai`);
  legacyDb = client.db(`${runId}_legacy`);
  await Promise.all([mainDb.command({ ping: 1 }), aiDb.command({ ping: 1 }), legacyDb.command({ ping: 1 })]);
}, 30_000);

beforeEach(async () => {
  if (runIntegration) await clear();
});

afterAll(async () => {
  if (runIntegration && typeof mainDb !== "undefined") {
    await Promise.all([mainDb.dropDatabase(), aiDb.dropDatabase(), legacyDb.dropDatabase()]);
  }
  await closeClient();
});

describe.runIf(runIntegration)("getCustomerProfile", () => {
  it("⭐ confirmed link เท่านั้นที่ทำให้เห็นประวัติ legacy", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_confirmed"));
    await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).insertOne(
      link("lnk_confirmed", "cus_confirmed", "lgp_confirmed", "confirmed")
    );
    await addLegacyPayment({ id: "lgy_confirmed", personId: "lgp_confirmed", amount: 12000, paidAt: "2025-02-01", courses: [{ code: "INNER" }] });

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_confirmed");
    expect(profile?.linkedLegacyPersonIds).toEqual(["lgp_confirmed"]);
    expect(profile?.purchases).toHaveLength(1);
    expect(profile?.purchases[0]).toMatchObject({ source: "legacy", amount: 12000 });
  });

  it("⭐ auto/needs_review ห้ามทำให้ประวัติ legacy โผล่ และต้องติดธงรอยืนยัน", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_unconfirmed"));
    await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).insertMany([
      link("lnk_auto", "cus_unconfirmed", "lgp_auto", "auto"),
      link("lnk_review", "cus_unconfirmed", "lgp_review", "needs_review"),
    ]);
    await addLegacyPayment({ id: "lgy_auto", personId: "lgp_auto", amount: 50000, paidAt: "2025-02-01", courses: [{ code: "INNER" }] });
    await addLegacyPayment({ id: "lgy_review", personId: "lgp_review", amount: 60000, paidAt: "2025-03-01", courses: [{ code: "COMMU" }] });

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_unconfirmed");
    expect(profile?.linkedLegacyPersonIds).toEqual([]);
    expect(profile?.purchases).toEqual([]);
    expect(profile?.totalPaid).toBe(0);
    expect(profile?.hasUnconfirmedLinks).toBe(true);
    expect(profile?.legacyHidden).toBe(true);
  });

  it("⭐ ยอดรวมมาจาก payment ครั้งเดียวแม้มีหลายคอร์ส", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_money"));
    await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).insertOne(
      link("lnk_money", "cus_money", "lgp_money", "confirmed")
    );
    await addPartnerPayment({
      id: "pur_money", customerId: "cus_money", amount: 33900, paidAt: "2026-08-20",
      courses: [{ code: "INNER" }, { code: "COMMU" }, { code: "PRESENT" }],
    });
    await addLegacyPayment({
      id: "lgy_money", personId: "lgp_money", amount: 20000, paidAt: "2025-02-01",
      courses: [{ code: "INNER" }, { code: "DEEPIN" }],
    });

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_money");
    expect(profile?.paymentCount).toBe(2);
    expect(profile?.purchases.flatMap((row) => row.courses)).toHaveLength(5);
    expect(profile?.totalPaid).toBe(53900);
    expect(profile?.totalPaid).not.toBe((33900 * 3) + (20000 * 2));
  });

  it("partner purchase ที่ customerId ตรงแสดงได้โดยไม่ต้องมี link", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_partner"));
    await addPartnerPayment({ id: "pur_direct", customerId: "cus_partner", amount: 9000, paidAt: "2026-08-25", courses: [{ code: "INNER" }] });

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_partner");
    expect(profile?.purchases).toHaveLength(1);
    expect(profile?.purchases[0]).toMatchObject({ source: "partner", amount: 9000 });
    expect(profile?.hasUnconfirmedLinks).toBe(false);
  });

  it("seatCount ไม่นับ relearn/free/refund", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_seats"));
    await addPartnerPayment({
      id: "pur_seats", customerId: "cus_seats", amount: 10000, paidAt: "2026-08-25",
      courses: [
        { code: "INNER", kind: "enrolled", countsAsSeat: true },
        { code: "INNER", kind: "relearn", countsAsSeat: false },
        { code: "COMMU", kind: "free", countsAsSeat: false },
        { code: "PRESENT", kind: "refund", countsAsSeat: false },
      ],
    });

    expect((await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_seats"))?.seatCount).toBe(1);
  });

  it("ไม่พบลูกค้าคืน null", async () => {
    expect(await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_missing")).toBeNull();
  });

  it("ลูกค้า erased ไม่มี PII ในผลลัพธ์", async () => {
    const erased = customer("cus_erased", "erased");
    erased.displayName = "ห้ามหลุด";
    erased.lineDisplayName = "ห้ามหลุดจาก LINE";
    erased.phone = "+66899999999";
    erased.email = "must-not-leak@example.test";
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(erased);

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_erased");
    expect(profile).toMatchObject({ status: "erased", displayName: null, phone: null, email: null, heardFrom: null });
  });

  it("confirmed links สองคนรวมประวัติได้ทั้งคู่", async () => {
    await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).insertOne(customer("cus_two_links"));
    await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).insertMany([
      link("lnk_two_a", "cus_two_links", "lgp_a", "confirmed"),
      link("lnk_two_b", "cus_two_links", "lgp_b", "confirmed"),
    ]);
    await addLegacyPayment({ id: "lgy_a", personId: "lgp_a", amount: 1000, paidAt: "2024-01-01", courses: [{ code: "INNER" }] });
    await addLegacyPayment({ id: "lgy_b", personId: "lgp_b", amount: 2000, paidAt: "2025-01-01", courses: [{ code: "COMMU" }] });

    const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, "cus_two_links");
    expect(profile?.linkedLegacyPersonIds.sort()).toEqual(["lgp_a", "lgp_b"]);
    expect(profile?.paymentCount).toBe(2);
    expect(profile?.totalPaid).toBe(3000);
    expect(profile?.purchases.map((row) => row.paidAt)).toEqual([
      "2025-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
    ]);
  });
});
