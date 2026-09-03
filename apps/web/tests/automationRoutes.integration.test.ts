import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { closeClient, getDb, COLLECTIONS, __resetEnvCache } from "@line-crm/core";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const d = runIntegration ? describe : describe.skip;
const secret = process.env.INTERNAL_HMAC_SECRET ?? "test-internal-hmac-secret-at-least-32-chars";

function signed(body: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { "content-type": "application/json", "x-signature": "sha256=" + crypto.createHmac("sha256", secret).update(`${body}.${ts}`).digest("hex"), "x-timestamp": String(ts) };
}
const req = (path: string, headers: Record<string,string>, body = '{"limit":10}') =>
  new Request("https://x.test" + path, { method: "POST", body, headers });

d("automation trigger endpoints", () => {
  beforeEach(() => {
    process.env.MONGODB_MIRROR_URI = process.env.MONGODB_URI;
    process.env.AI_MONGODB_DB = process.env.MONGODB_DB; // ทดสอบ: ชี้ ai ไปฐานเทสเดียวกัน
    __resetEnvCache();
  });
  afterAll(async () => { await closeClient(); });

  it("⭐ ทุก endpoint ปฏิเสธลายเซ็นผิด (401)", async () => {
    const bad = { "content-type": "application/json", "x-signature": "sha256=bad", "x-timestamp": "1" };
    for (const p of ["/api/internal/leads/sync", "/api/internal/partner/reconcile", "/api/internal/partner/scrub", "/api/internal/match/build", "/api/internal/facebook/posts", "/api/internal/sheets/marketing"]) {
      const mod = await import(`../app${p}/route`);
      expect((await mod.POST(req(p, bad))).status, p).toBe(401);
    }
  });

  it("leads/sync เซ็นถูก → 200 (ยังไม่ตั้ง FB token = configured:false ไม่ error)", async () => {
    const mod = await import("../app/api/internal/leads/sync/route");
    const res = await mod.POST(req("/api/internal/leads/sync", signed('{"limit":10}')));
    expect(res.status).toBe(200);
    expect((await res.json()).configured).toBe(false);
  });

  it("facebook/posts เซ็นถูก → 200 และปิดเงียบเมื่อยังไม่ตั้ง token", async () => {
    delete process.env.FACEBOOK_PAGE_TOKEN;
    delete process.env.FACEBOOK_PAGE_ID;
    __resetEnvCache();
    const mod = await import("../app/api/internal/facebook/posts/route");
    const res = await mod.POST(req("/api/internal/facebook/posts", signed("{}"), "{}"));
    expect(res.status).toBe(200);
    expect((await res.json()).configured).toBe(false);
  });

  it("sheets/marketing เซ็นถูก → snapshot ครบ 3 tab", async () => {
    const mod = await import("../app/api/internal/sheets/marketing/route");
    const res = await mod.POST(req("/api/internal/sheets/marketing", signed("{}"), "{}"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.tabs.map((tab: { name: string }) => tab.name)).toEqual(["Customers", "FB Leads", "FB Posts"]);
  });

  it("partner/reconcile เซ็นถูก → 200", async () => {
    const mod = await import("../app/api/internal/partner/reconcile/route");
    const res = await mod.POST(req("/api/internal/partner/reconcile", signed('{"limit":10}')));
    expect(res.status).toBe(200);
  });

  it("⭐ partner/scrub เซ็นถูก → 200 และ scrub ของที่ค้างจริง", async () => {
    const db = await getDb();
    await db.collection(COLLECTIONS.purchases).deleteMany({});
    await db.collection(COLLECTIONS.purchases).insertOne({
      _id: "pur_auto1", customerId: "cus_1", amount: 1000, currency: "THB", paidAt: new Date("2026-08-10"),
      year: 2026, month: 8, saleRep: "TT", status: "active", sourceEventId: "e1",
      aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
      createdAt: new Date(), updatedAt: new Date(), schemaVersion: 1,
    } as never);
    const mod = await import("../app/api/internal/partner/scrub/route");
    const res = await mod.POST(req("/api/internal/partner/scrub", signed("{}"), "{}"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.purchases).toBeGreaterThanOrEqual(1);
    // ตรวจว่า dirty ถูกเคลียร์
    expect(await db.collection(COLLECTIONS.purchases).countDocuments({ "aiSync.dirty": true })).toBe(0);
    await db.collection(COLLECTIONS.purchases).deleteMany({});
    await db.collection("purchases_scrubbed").deleteMany({});
  });

  it("match/build เซ็นถูก → 200", async () => {
    const mod = await import("../app/api/internal/match/build/route");
    const res = await mod.POST(req("/api/internal/match/build", signed("{}"), "{}"));
    expect(res.status).toBe(200);
  });

  it("scrub/match คืน error ชัดเมื่อไม่ตั้ง MONGODB_MIRROR_URI", async () => {
    delete process.env.MONGODB_MIRROR_URI;
    __resetEnvCache();
    const mod = await import("../app/api/internal/match/build/route");
    const res = await mod.POST(req("/api/internal/match/build", signed("{}"), "{}"));
    expect(res.status).toBe(500);
  });
});
