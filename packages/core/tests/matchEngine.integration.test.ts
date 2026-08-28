import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { AI_COLLECTIONS, type CustomerLinkDoc } from "../src/db/models";
import { closeClient, getDb } from "../src/db/client";
import { ensureAiIndexes } from "../src/ai/indexes";
import { nameKeys } from "../src/ai/tokens";
import { buildCustomerLinks, verifyCustomerLinks } from "../src/match/engine";
import { plantMatchFixtures, unplantMatchFixtures } from "../src/match/fixtures";
import type { MatchLegacyRow } from "../src/match/candidates";
import type { LlmProvider } from "../src/ai/llm/provider";
import type { ZodType } from "zod";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
let db: Db;

function legacy(index: number): MatchLegacyRow {
  return {
    _id: `lgp_MATCH_${String(index).padStart(3, "0")}`,
    phone: `08x-xxx-${String(1000 + index)}`,
    email: `u${index}***@domain${index}.test`,
    phoneHash: `phone-${index}`,
    emailHash: `email-${index}`,
    nameKeys: nameKeys(`UniqueFirst${index} UniqueLast${index}`),
    nicknameKey: nameKeys(`Nick${index}`)[0]!,
    ageBand: `${20 + (index % 5) * 10}-${29 + (index % 5) * 10}`,
    firstPaidAt: "2025-01-01",
    courseCodes: ["INNER"],
  };
}

function llm(decision: "same" | "different"): LlmProvider {
  return {
    name: `fake-${decision}`,
    async complete<T>(input: { system: string; user: string; schema: ZodType<T>; maxTokens?: number }): Promise<T> {
      const payload = JSON.parse(input.user) as { pairs: Array<{ pairId: string }> };
      return input.schema.parse({
        matches: payload.pairs.map(({ pairId }) => ({ pairId, decision, confidence: 0.9, reason: "Feature comparison result." })),
      });
    },
  };
}

async function reset(): Promise<void> {
  await unplantMatchFixtures(db);
  await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).deleteMany({ legacyPersonId: { $regex: "^lgp_MATCH_" } });
  await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).deleteMany({ _id: { $regex: "^lgp_MATCH_" } });
  await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).insertMany(Array.from({ length: 20 }, (_, index) => legacy(index)));
}

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await db.command({ ping: 1 });
  await ensureAiIndexes(db);
}, 30_000);

beforeEach(async () => {
  if (runIntegration) await reset();
});

afterAll(async () => {
  if (runIntegration) {
    await unplantMatchFixtures(db);
    await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).deleteMany({ legacyPersonId: { $regex: "^lgp_MATCH_" } });
    await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).deleteMany({ _id: { $regex: "^lgp_MATCH_" } });
  }
  await closeClient();
});

describe.runIf(runIntegration)("S11-M3 match engine", () => {
  it("ปลูก fixture แล้วสร้าง link ได้ตามจำนวน", async () => {
    const planted = await plantMatchFixtures(db, 8, new Date("2026-08-28T00:00:00Z"));
    await buildCustomerLinks(db, { llmProvider: null, now: new Date("2026-08-28T01:00:00Z") });
    expect(await db.collection(AI_COLLECTIONS.customerLinks).countDocuments({ customerId: { $regex: "^cus_PLANT_" } })).toBe(planted.total - planted.noMatch);
  });

  it("รันซ้ำแล้วไม่มี link ซ้ำ", async () => {
    await plantMatchFixtures(db, 8);
    await buildCustomerLinks(db, { llmProvider: null });
    const first = await db.collection(AI_COLLECTIONS.customerLinks).countDocuments({ customerId: { $regex: "^cus_PLANT_" } });
    await buildCustomerLinks(db, { llmProvider: null });
    expect(await db.collection(AI_COLLECTIONS.customerLinks).countDocuments({ customerId: { $regex: "^cus_PLANT_" } })).toBe(first);
  });

  it("link confirmed ไม่ถูกเครื่องทับ", async () => {
    await plantMatchFixtures(db, 8);
    await buildCustomerLinks(db, { llmProvider: null });
    const links = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
    const target = await links.findOne({ customerId: { $regex: "^cus_PLANT_PHONE_" } });
    expect(target).toBeTruthy();
    await links.updateOne({ _id: target!._id }, { $set: { status: "confirmed", decidedBy: "staff", score: 0.42 } });
    await buildCustomerLinks(db, { llmProvider: null });
    expect(await links.findOne({ _id: target!._id })).toMatchObject({ status: "confirmed", decidedBy: "staff", score: 0.42 });
  });

  it("ครอบครัว 3 คนใช้เบอร์เดียวกันไม่มี auto", async () => {
    await plantMatchFixtures(db, 8);
    await buildCustomerLinks(db, { llmProvider: null });
    const family = await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
      .find({ customerId: { $regex: "^cus_PLANT_FAMILY_" } }).toArray();
    expect(family).toHaveLength(3);
    expect(family.every((link) => link.status === "needs_review" && link.evidence.competingCandidates > 0)).toBe(true);
  });

  it("หลักฐานหายแล้วถอดเฉพาะ link ที่เครื่องสร้าง", async () => {
    await plantMatchFixtures(db, 8);
    await buildCustomerLinks(db, { llmProvider: null });
    const customers = db.collection(AI_COLLECTIONS.customersScrubbed);
    const links = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
    const customerId = "cus_PLANT_PHONE_001";
    expect(await links.countDocuments({ customerId })).toBe(1);
    await customers.updateOne({ customerId }, { $set: { phone: null, phoneHash: null } });
    const report = await buildCustomerLinks(db, { llmProvider: null });
    expect(report.removed).toBeGreaterThanOrEqual(1);
    expect(await links.countDocuments({ customerId })).toBe(0);
  });

  it("verify ผ่านได้เมื่อฐานปกติไม่มี fixture", async () => {
    expect(await verifyCustomerLinks(db)).toMatchObject({ ok: true, plantCustomers: 0, plantLinks: 0 });
  });

  it("LLM timeout ไม่ลบ link เดิม แต่ different จริงถอด link เครื่อง", async () => {
    await plantMatchFixtures(db, 8);
    const customers = db.collection(AI_COLLECTIONS.customersScrubbed);
    const links = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
    const source = await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).findOne({});
    const customerId = "cus_PLANT_NOMATCH_001";
    await customers.updateOne({ customerId }, { $set: { nameKeys: [source!.nameKeys![0]!], birthYear: null } });

    await buildCustomerLinks(db, { llmProvider: llm("same") });
    const created = await links.countDocuments({ customerId, decidedBy: "llm" });
    expect(created).toBeGreaterThan(0);

    const timeout: LlmProvider = { name: "timeout", complete: async () => { throw new Error("timeout"); } };
    await buildCustomerLinks(db, { llmProvider: timeout });
    expect(await links.countDocuments({ customerId, decidedBy: "llm" })).toBe(created);

    await buildCustomerLinks(db, { llmProvider: llm("different") });
    expect(await links.countDocuments({ customerId, decidedBy: "llm" })).toBe(0);
  });

  it("⭐ verify ต้องไม่ตกเพราะ link ที่ LLM สร้าง — LLM เพิ่ม needs_review ได้เสมอ", async () => {
    await plantMatchFixtures(db, 16);
    await buildCustomerLinks(db, { llmProvider: null });
    const withoutLlm = await verifyCustomerLinks(db);
    expect(withoutLlm.ok).toBe(true);

    await buildCustomerLinks(db, { llmProvider: llm("same") });
    const withLlm = await verifyCustomerLinks(db);
    expect(withLlm.plantLinks).toBeGreaterThan(withLlm.plantRuleLinks);
    expect(withLlm.plantRuleLinks).toBe(withLlm.expectedPlantLinks);
    expect(withLlm.ok).toBe(true);
  });

  it("⭐ นับ link ของพนักงานที่ถูกป้องกันไม่ให้ลบ — ไม่ใช่รายงาน 0 ทั้งที่ป้องกันจริง", async () => {
    await plantMatchFixtures(db, 8);
    const links = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
    const customers = db.collection(AI_COLLECTIONS.customersScrubbed);
    const source = await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).findOne({});
    const customerId = "cus_PLANT_NOMATCH_001";
    await customers.updateOne({ customerId }, { $set: { nameKeys: [source!.nameKeys![0]!], birthYear: null } });

    await buildCustomerLinks(db, { llmProvider: llm("same") });
    const created = await links.findOne({ customerId, decidedBy: "llm" });
    await links.updateOne({ _id: created!._id }, { $set: { status: "confirmed", decidedBy: "staff" } });

    // รอบใหม่ LLM ตอบ different → ปกติจะถอด link นี้ แต่พนักงานยืนยันแล้วห้ามแตะ
    const report = await buildCustomerLinks(db, { llmProvider: llm("different") });
    expect(await links.countDocuments({ _id: created!._id })).toBe(1);
    expect(report.preservedStaff).toBeGreaterThan(0);
  });
});
