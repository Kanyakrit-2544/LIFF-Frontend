import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { closeClient, getDb } from "../src/db/client";
import { AI_COLLECTIONS } from "../src/db/models";
import { runAnalytics } from "../src/analytics/aggregate";
import { analyticsQuerySchema, type AnalyticsQuery } from "../src/analytics/query";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const d = runIntegration ? describe : describe.skip;
let db: Db;

const q = (o: Partial<AnalyticsQuery> & { metric: AnalyticsQuery["metric"] }): AnalyticsQuery =>
  analyticsQuerySchema.parse({ from: "2026-08-01", to: "2026-08-31", ...o });

async function reset(): Promise<void> {
  for (const c of Object.values(AI_COLLECTIONS)) await db.collection(c).deleteMany({});
}

/** 1 การชำระ 33,900 ที่มี 3 คอร์ส — เคสที่ทำให้ยอดเบิ้ลถ้าคำนวณผิด */
async function seedOnePaymentThreeCourses(): Promise<void> {
  await db.collection(AI_COLLECTIONS.purchasesScrubbed).insertOne({
    _id: "pur_A", customerId: "cus_1", amount: 33900, paidAt: "2026-08-10", year: 2026, month: 8,
    saleRep: "TT", status: "active", synthetic: false, syncedAt: "2026-08-10T00:00:00Z",
  } as never);
  const items = [
    { _id: "pit_1", courseCode: "INNER", kind: "enrolled", countsAsSeat: true },
    { _id: "pit_2", courseCode: "COMMU", kind: "relearn", countsAsSeat: false },
    { _id: "pit_3", courseCode: "DEEPIN", kind: "enrolled", countsAsSeat: true },
  ].map((i) => ({ ...i, purchaseId: "pur_A", customerId: "cus_1", sessionStart: "2026-08-10", synthetic: false, syncedAt: "2026-08-10T00:00:00Z" }));
  await db.collection(AI_COLLECTIONS.purchaseItemsScrubbed).insertMany(items as never[]);
}

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await db.command({ ping: 1 });
}, 30_000);
beforeEach(async () => { if (runIntegration) await reset(); });
afterAll(async () => { if (runIntegration) { await reset(); await closeClient(); } });

d("revenue", () => {
  it("⭐ 1 การชำระที่มี 3 คอร์ส = นับเงินครั้งเดียว ไม่ใช่ 3 เท่า", async () => {
    await seedOnePaymentThreeCourses();
    const r = await runAnalytics(db, q({ metric: "revenue" }));
    expect(r.total).toBe(33900);
    expect(r.total).not.toBe(33900 * 3);
  });

  it("การชำระที่ถูกยกเลิกไม่ถูกนับ", async () => {
    await seedOnePaymentThreeCourses();
    await db.collection(AI_COLLECTIONS.purchasesScrubbed).insertOne({
      _id: "pur_void", customerId: "cus_2", amount: 99999, paidAt: "2026-08-11", year: 2026, month: 8,
      saleRep: "OO", status: "voided", synthetic: false, syncedAt: "x",
    } as never);
    expect((await runAnalytics(db, q({ metric: "revenue" }))).total).toBe(33900);
  });

  it("groupBy course เตือนว่าแบ่งยอดเงินตามคอร์สไม่ได้", async () => {
    await seedOnePaymentThreeCourses();
    const r = await runAnalytics(db, q({ metric: "revenue", groupBy: "course" }));
    expect(r.total).toBe(33900);
    expect(r.meta.warnings.join(" ")).toContain("หนึ่งการชำระมีได้หลายคอร์ส");
  });
});

d("seats", () => {
  it("⭐ relearn ไม่ถูกนับเป็นที่นั่งที่ขายได้", async () => {
    await seedOnePaymentThreeCourses();
    const r = await runAnalytics(db, q({ metric: "seats", groupBy: "course" }));
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x.key).sort()).toEqual(["DEEPIN", "INNER"]);
  });
});

d("ข้อมูลจำลอง (D37)", () => {
  beforeEach(async () => {
    await db.collection(AI_COLLECTIONS.legacyPaymentsScrubbed).insertOne({
      _id: "lgy_fake", personId: "lgp_1", amount: 500000, paidAt: "2026-08-05",
      year: 2026, month: 8, saleRep: "OO", synthetic: true, syncedAt: "x",
    } as never);
  });

  it("⭐ ค่าเริ่มต้นไม่รวมข้อมูลจำลอง และบอกไว้ใน warnings", async () => {
    const r = await runAnalytics(db, q({ metric: "revenue" }));
    expect(r.total).toBe(0);
    expect(r.meta.containsSynthetic).toBe(false);
    expect(r.meta.warnings.join(" ")).toContain("ไม่รวมข้อมูลจำลอง");
  });

  it("ขอเข้ามาถึงจะโผล่ และต้องติดธงเตือน", async () => {
    const r = await runAnalytics(db, q({ metric: "revenue", includeSynthetic: true }));
    expect(r.total).toBe(500000);
    expect(r.meta.containsSynthetic).toBe(true);
    expect(r.meta.warnings.join(" ")).toContain("ห้ามนำไปใช้ตัดสินใจ");
  });
});

d("new_vs_returning (§5.4)", () => {
  it("⭐ เคยซื้อก่อนหน้า = returning · ไม่เคย = new", async () => {
    await db.collection(AI_COLLECTIONS.purchasesScrubbed).insertMany([
      { _id: "p_old", customerId: "cus_old", amount: 100, paidAt: "2025-03-01", year: 2025, month: 3, status: "active", synthetic: false, syncedAt: "x" },
      { _id: "p_1", customerId: "cus_old", amount: 200, paidAt: "2026-08-10", year: 2026, month: 8, status: "active", synthetic: false, syncedAt: "x" },
      { _id: "p_2", customerId: "cus_new", amount: 300, paidAt: "2026-08-12", year: 2026, month: 8, status: "active", synthetic: false, syncedAt: "x" },
    ] as never[]);
    const r = await runAnalytics(db, q({ metric: "new_vs_returning" }));
    expect(r.rows.find((x) => x.key === "returning")!.value).toBe(1);
    expect(r.rows.find((x) => x.key === "new")!.value).toBe(1);
  });

  it("⭐ มี link แต่ไม่เคยซื้อก่อนหน้า ยังนับเป็นลูกค้าใหม่", async () => {
    await db.collection(AI_COLLECTIONS.customerLinks).insertOne({
      _id: "lnk_1", customerId: "cus_linked", legacyPersonId: "lgp_x", method: "phone_hash",
      confidence: "high", score: 0.95, status: "auto", evidence: {}, decidedBy: "rule",
      decidedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), schemaVersion: 1,
    } as never);
    await db.collection(AI_COLLECTIONS.purchasesScrubbed).insertOne({
      _id: "p_x", customerId: "cus_linked", amount: 500, paidAt: "2026-08-15", year: 2026, month: 8,
      status: "active", synthetic: false, syncedAt: "x",
    } as never);
    const r = await runAnalytics(db, q({ metric: "new_vs_returning" }));
    expect(r.rows.find((x) => x.key === "new")!.value).toBe(1);
    expect(r.rows.find((x) => x.key === "returning")!.value).toBe(0);
  });
});

d("channel_mix (§5.5)", () => {
  it('⭐ "ยังไม่รู้" แยกจาก "unknown" ไม่ยุบรวมกัน', async () => {
    await db.collection(AI_COLLECTIONS.customersScrubbed).insertMany([
      { _id: "c1", status: "active", heardFrom: "Facebook", leadAttribution: { courseCode: null, campaignName: null, adOrOrganic: "ad", attributionPending: false } },
      { _id: "c2", status: "active", heardFrom: "Facebook", leadAttribution: { courseCode: null, campaignName: null, adOrOrganic: "unknown", attributionPending: true } },
      { _id: "c3", status: "active", heardFrom: "เพื่อนแนะนำ", leadAttribution: null },
    ] as never[]);
    const r = await runAnalytics(db, q({ metric: "channel_mix", groupBy: "adOrOrganic" }));
    const keys = r.rows.map((x) => x.key);
    expect(keys).toContain("ad");
    expect(keys).toContain("ยังไม่รู้ (รอเติม mapping)");
    expect(keys).toContain("ไม่ได้มาจากโฆษณา");
    expect(r.meta.warnings.join(" ")).toContain("เติม lead_form_mappings");
  });

  it("จัดกลุ่มตาม heardFrom ได้", async () => {
    await db.collection(AI_COLLECTIONS.customersScrubbed).insertMany([
      { _id: "c1", status: "active", heardFrom: "Facebook" },
      { _id: "c2", status: "active", heardFrom: "Facebook" },
      { _id: "c3", status: "active", heardFrom: null },
    ] as never[]);
    const r = await runAnalytics(db, q({ metric: "channel_mix", groupBy: "channel" }));
    expect(r.rows.find((x) => x.key === "Facebook")!.value).toBe(2);
    expect(r.rows.find((x) => x.key === "ไม่ระบุ")!.value).toBe(1);
  });
});

d("intent_funnel (D39)", () => {
  it("⭐ ตัด belowThreshold และ confidence ต่ำออก และติดธงว่าเป็นค่าประเมิน", async () => {
    await db.collection(AI_COLLECTIONS.customerIntentsScrubbed).insertMany([
      { _id: "i1", customerId: "c1", courseCode: "INNER", status: "hesitant", hesitationReason: "budget", confidence: 0.9, belowThreshold: false, supersededAt: null, voidedAt: null, model: "m1" },
      { _id: "i2", customerId: "c2", courseCode: "INNER", status: "hesitant", hesitationReason: "budget", confidence: 0.3, belowThreshold: true, supersededAt: null, voidedAt: null, model: "m1" },
      { _id: "i3", customerId: "c3", courseCode: "INNER", status: "interested", confidence: 0.95, belowThreshold: false, supersededAt: new Date(), voidedAt: null, model: "m1" },
    ] as never[]);
    const r = await runAnalytics(db, q({ metric: "intent_funnel" }));
    expect(r.total).toBe(1);
    expect(r.meta.isEstimate).toBe(true);
    expect(r.meta.warnings.join(" ")).toContain("ค่าประเมินจาก AI");
    expect(r.meta.warnings.join(" ")).toContain("m1");
  });
});

d("delta", () => {
  it("⭐ groupBy ต้องไม่ทำให้เรียกตัวเองซ้ำไม่รู้จบ — เคยพังมาแล้ว", async () => {
    await seedOnePaymentThreeCourses();
    const r = await Promise.race([
      runAnalytics(db, q({ metric: "seats", groupBy: "course" })),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("recursion ไม่จบ")), 3000)),
    ]);
    expect(r.rows.every((x) => typeof x.delta === "number")).toBe(true);
  });

  it("delta เทียบกับช่วงก่อนหน้าที่ยาวเท่ากัน", async () => {
    await db.collection(AI_COLLECTIONS.purchasesScrubbed).insertMany([
      { _id: "p_prev", customerId: "c1", amount: 1000, paidAt: "2026-07-15", year: 2026, month: 7, status: "active", synthetic: false, syncedAt: "x" },
      { _id: "p_cur", customerId: "c1", amount: 2500, paidAt: "2026-08-15", year: 2026, month: 8, status: "active", synthetic: false, syncedAt: "x" },
    ] as never[]);
    const r = await runAnalytics(db, q({ metric: "revenue", groupBy: "month" }));
    expect(r.rows[0]!.value).toBe(2500);
    expect(r.rows[0]!.delta).toBe(2500); // เดือนก่อนคนละคีย์ จึงเทียบกับ 0
  });
});

d("ความเสถียร (D40)", () => {
  it("รัน query เดิมซ้ำได้ผลเท่ากัน", async () => {
    await seedOnePaymentThreeCourses();
    const a = await runAnalytics(db, q({ metric: "seats", groupBy: "course" }));
    const b = await runAnalytics(db, q({ metric: "seats", groupBy: "course" }));
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
  });
});
