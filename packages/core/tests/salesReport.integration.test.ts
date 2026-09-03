import type { Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AI_COLLECTIONS, COLLECTIONS, closeClient, getClient, listSalesReport } from "../src/index";
import { LEGACY_COLLECTIONS } from "../src/legacy/models";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const prefix = `sales_report_${process.pid}`;
let client: MongoClient;
let mainDb: Db;
let aiDb: Db;
let legacyDb: Db;

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

describe.runIf(runIntegration)("listSalesReport", () => {
  it("⭐ อ่าน legacy เฉพาะ confirmed link และไม่เบิ้ลยอดเมื่อบิลมีหลายคอร์ส", async () => {
    await mainDb.collection(COLLECTIONS.customers).insertOne({
      _id: "cus_sales", displayName: "Sales Test", lineDisplayName: null, nickname: null,
      customerStatus: "customer", createdAt: new Date("2026-08-01"),
    } as never);
    await mainDb.collection(COLLECTIONS.purchases).insertOne({
      _id: "pur_sales", customerId: "cus_sales", amount: 42_000, paidAt: new Date("2026-08-20"),
      status: "active", createdAt: new Date("2026-08-20"),
    } as never);
    await mainDb.collection(COLLECTIONS.purchaseItems).insertMany([
      { _id: "pit_sales_1", purchaseId: "pur_sales", courseCode: "INNER", countsAsSeat: true },
      { _id: "pit_sales_2", purchaseId: "pur_sales", courseCode: "COMMU", countsAsSeat: true },
      { _id: "pit_sales_3", purchaseId: "pur_sales", courseCode: "PRESENT", countsAsSeat: true },
    ] as never[]);
    await legacyDb.collection(LEGACY_COLLECTIONS.persons).insertOne({
      _id: "lgp_sales", totalPaid: 125_000, lastPaidAt: new Date("2025-12-15"),
    } as never);
    await aiDb.collection(AI_COLLECTIONS.customerLinks).insertOne({
      _id: "lnk_sales", customerId: "cus_sales", legacyPersonId: "lgp_sales", status: "needs_review",
    } as never);

    const hidden = await listSalesReport(mainDb, aiDb, legacyDb);
    expect(hidden.rows[0]).toMatchObject({ kind: "new", newPurchaseTotal: 42_000, newSeatCount: 3 });
    expect(hidden.rows[0]!.legacyContext).toBeUndefined();

    await aiDb.collection<{ _id: string; status: string }>(AI_COLLECTIONS.customerLinks).updateOne(
      { _id: "lnk_sales" }, { $set: { status: "confirmed" } }
    );
    const confirmed = await listSalesReport(mainDb, aiDb, legacyDb);
    expect(confirmed.rows[0]).toMatchObject({
      kind: "returning",
      newPurchaseTotal: 42_000,
      legacyContext: { totalPaid: 125_000 },
    });
    expect(confirmed.summary.revenue).toBe(42_000);
  });
});
