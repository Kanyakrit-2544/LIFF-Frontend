import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AI_COLLECTIONS,
  COLLECTIONS,
  closeClient,
  getClient,
  listSalesOpportunities,
} from "../src/index";
import { LEGACY_COLLECTIONS } from "../src/legacy/models";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const NOW = new Date("2026-09-02T00:00:00.000Z");
const prefix = `recommend_${process.pid}`;
let client: MongoClient;
let mainDb: Db;
let aiDb: Db;
let legacyDb: Db;

function activeCustomer(id: string, marketing = true) {
  return {
    _id: id,
    status: "active",
    displayName: id,
    lineDisplayName: null,
    consent: { marketing, dataProcessing: true, version: "test", grantedAt: NOW, ip: null, userAgent: null },
  };
}

beforeAll(async () => {
  if (!runIntegration) return;
  client = await getClient();
  mainDb = client.db(`${prefix}_main`);
  aiDb = client.db(`${prefix}_ai`);
  legacyDb = client.db(`${prefix}_legacy`);
  await Promise.all([mainDb.command({ ping: 1 }), aiDb.command({ ping: 1 }), legacyDb.command({ ping: 1 })]);
}, 30_000);

beforeEach(async () => {
  if (!runIntegration) return;
  await Promise.all([mainDb.dropDatabase(), aiDb.dropDatabase(), legacyDb.dropDatabase()]);
});

afterAll(async () => {
  if (runIntegration && typeof mainDb !== "undefined") {
    await Promise.all([mainDb.dropDatabase(), aiDb.dropDatabase(), legacyDb.dropDatabase()]);
  }
  await closeClient();
});

describe.runIf(runIntegration)("listSalesOpportunities", () => {
  it("⭐ legacy upsell ใช้เฉพาะ confirmed link ตาม D23", async () => {
    await mainDb.collection(COLLECTIONS.customers).insertOne(activeCustomer("cus_d23") as never);
    await legacyDb.collection(LEGACY_COLLECTIONS.enrollments).insertOne({
      _id: "lge_d23", personId: "lgp_d23", paymentId: "lgy_d23", courseCode: "INNER",
      countsAsSeat: true, sessionStart: new Date("2026-08-01"), synthetic: false,
    } as never);
    await aiDb.collection(AI_COLLECTIONS.customerLinks).insertOne({
      _id: "lnk_d23", customerId: "cus_d23", legacyPersonId: "lgp_d23", status: "needs_review",
    } as never);

    expect((await listSalesOpportunities(mainDb, aiDb, legacyDb, NOW)).upsells).toEqual([]);
    await aiDb.collection<{ _id: string; status: string }>(AI_COLLECTIONS.customerLinks).updateOne(
      { _id: "lnk_d23" }, { $set: { status: "confirmed" } }
    );
    expect((await listSalesOpportunities(mainDb, aiDb, legacyDb, NOW)).upsells).toHaveLength(3);
  });

  it("⭐ recommendation_reviews ทำให้รายการที่กดแล้วหาย", async () => {
    await mainDb.collection(COLLECTIONS.customers).insertOne(activeCustomer("cus_reviewed") as never);
    await mainDb.collection(COLLECTIONS.customerIntents).insertOne({
      _id: "int_reviewed", customerId: "cus_reviewed", courseCode: "COMMU", status: "hesitant",
      hesitationReason: "budget", confidence: 0.8, observedAt: NOW, supersededAt: null, voidedAt: null,
    } as never);
    const before = await listSalesOpportunities(mainDb, aiDb, legacyDb, NOW);
    expect(before.followUps.map((row) => row.recoId)).toEqual(["follow_up:cus_reviewed:COMMU"]);

    await mainDb.collection(COLLECTIONS.recommendationReviews).insertOne({
      _id: "follow_up:cus_reviewed:COMMU", type: "follow_up", customerId: "cus_reviewed",
      courseCode: "COMMU", status: "done", staffEmail: "staff@example.test", at: NOW,
    } as never);
    expect((await listSalesOpportunities(mainDb, aiDb, legacyDb, NOW)).followUps).toEqual([]);
  });
});
