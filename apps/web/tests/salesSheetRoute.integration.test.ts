import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_COLLECTIONS, COLLECTIONS, __resetEnvCache, closeClient, getDb } from "@line-crm/core";
import { closeAdminClient } from "@/lib/adminDb";
import { MongoClient, type Db } from "mongodb";
import { LEGACY_COLLECTIONS } from "../../../packages/core/src/legacy/models";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const secret = process.env.INTERNAL_HMAC_SECRET ?? "test-internal-hmac-secret-at-least-32-chars";
const prefix = `sales_sheet_${process.pid}`;
const originalEnv = {
  ADMIN_MONGODB_URI: process.env.ADMIN_MONGODB_URI,
  AI_MONGODB_DB: process.env.AI_MONGODB_DB,
  LEGACY_MONGODB_DB: process.env.LEGACY_MONGODB_DB,
};
let externalClient: MongoClient;
let aiDb: Db;
let legacyDb: Db;

function headers(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(timestamp),
    "x-signature": `sha256=${crypto.createHmac("sha256", secret).update(`${body}.${timestamp}`).digest("hex")}`,
  };
}

beforeAll(async () => {
  if (!runIntegration) return;
  process.env.ADMIN_MONGODB_URI = process.env.MONGODB_URI;
  process.env.AI_MONGODB_DB = `${prefix}_ai`;
  process.env.LEGACY_MONGODB_DB = `${prefix}_legacy`;
  __resetEnvCache();
  externalClient = await new MongoClient(process.env.MONGODB_URI!).connect();
  aiDb = externalClient.db(process.env.AI_MONGODB_DB);
  legacyDb = externalClient.db(process.env.LEGACY_MONGODB_DB);
});

afterAll(async () => {
  if (runIntegration && typeof aiDb !== "undefined") {
    await Promise.all([aiDb.dropDatabase(), legacyDb.dropDatabase()]);
    await externalClient.close();
  }
  await Promise.all([closeAdminClient(), closeClient()]);
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetEnvCache();
});

describe.runIf(runIntegration)("POST /api/internal/sheets/pending sales report", () => {
  it("คืนแท็บสรุปที่ใช้เฉพาะ confirmed link และยังทำงานเมื่อไม่มี dirty customer", async () => {
    const mainDb = await getDb();
    await Promise.all([
      mainDb.collection<{ _id: string }>(COLLECTIONS.customers).deleteMany({ _id: "cus_sales_route" }),
      mainDb.collection<{ _id: string }>(COLLECTIONS.purchases).deleteMany({ _id: "pur_sales_route" }),
      mainDb.collection<{ purchaseId: string }>(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: "pur_sales_route" }),
    ]);
    await mainDb.collection(COLLECTIONS.customers).insertOne({
      _id: "cus_sales_route", displayName: "Route Test", customerStatus: "customer",
      createdAt: new Date("2026-08-01"),
      sheetSync: { dirty: false, rowKey: "cus_sales_route", syncedAt: new Date(), lockedAt: null, attempts: 0 },
    } as never);
    await mainDb.collection(COLLECTIONS.purchases).insertOne({
      _id: "pur_sales_route", customerId: "cus_sales_route", amount: 8_000,
      paidAt: new Date("2026-08-20"), status: "active", createdAt: new Date("2026-08-20"),
    } as never);
    await mainDb.collection(COLLECTIONS.purchaseItems).insertOne({
      _id: "pit_sales_route", purchaseId: "pur_sales_route", courseCode: "INNER", countsAsSeat: true,
    } as never);
    await aiDb.collection(AI_COLLECTIONS.customerLinks).insertOne({
      _id: "lnk_sales_route", customerId: "cus_sales_route", legacyPersonId: "lgp_sales_route", status: "confirmed",
    } as never);
    await legacyDb.collection(LEGACY_COLLECTIONS.persons).insertOne({
      _id: "lgp_sales_route", totalPaid: 20_000, lastPaidAt: new Date("2025-01-01"),
    } as never);

    const body = "{\"limit\":10}";
    const route = await import("../app/api/internal/sheets/pending/route");
    const response = await route.POST(new Request("https://example.test/api/internal/sheets/pending", {
      method: "POST", headers: headers(body), body,
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.claimed).toBe(0);
    expect(json.salesReport.tab).toBe("สรุปการขาย");
    expect(json.salesReport.values[2]).toEqual(["Route Test", "🔁 กลับมาซื้อ", "INNER", 8_000, 20_000, "2026-08-20"]);

    await Promise.all([
      mainDb.collection<{ _id: string }>(COLLECTIONS.customers).deleteMany({ _id: "cus_sales_route" }),
      mainDb.collection<{ _id: string }>(COLLECTIONS.purchases).deleteMany({ _id: "pur_sales_route" }),
      mainDb.collection<{ purchaseId: string }>(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: "pur_sales_route" }),
    ]);
  });
});
