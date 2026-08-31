import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { closeClient, getDb } from "../src/db/client";
import { COLLECTIONS } from "../src/db/models";
import { ensureIndexes } from "../src/db/indexes";
import { intakePartnerEvents } from "../src/partner/intake";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const d = runIntegration ? describe : describe.skip;
let db: Db;

const LINE_USER = "Uerase0000000001";

const purchase = (id: string) => ({
  eventId: id, type: "purchase", occurredAt: "2026-08-28T10:15:00+07:00", revision: 1,
  subject: { lineUserId: LINE_USER, phone: "0812345678", email: "erase.me@example.com", fullName: "ทดสอบ ลบข้อมูล" },
  payment: {
    externalPaymentId: "IN-ERASE-1", amount: 19710, currency: "THB", paidAt: "2026-08-28", saleRep: "TT",
    lines: [{ courseLabel: "Inner", kind: "enrolled" }],
  },
});
const intent = (id: string) => ({
  eventId: id, type: "intent", occurredAt: "2026-08-28T11:00:00+07:00", revision: 1,
  subject: { lineUserId: LINE_USER },
  intent: { courseCode: "INNER", status: "interested", confidence: 0.9, source: "ai", model: "m1" },
});
const erase = (id: string, subject: Record<string, unknown>) => ({
  eventId: id, type: "erase", occurredAt: "2026-08-29T09:00:00+07:00", revision: 1,
  subject, erase: { reason: "customer_request" },
});

async function reset(): Promise<void> {
  for (const c of ["partner_events","purchases","purchase_items","customer_intents","partner_quarantine","customers","identities","customer_profiles","audit_logs"]) {
    await db.collection(c).deleteMany({});
  }
}

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
}, 30_000);
beforeEach(async () => { if (runIntegration) await reset(); });
afterAll(async () => { if (runIntegration) { await reset(); await closeClient(); } });

d("erase — ลบข้อมูลส่วนบุคคลตามคำขอ (PDPA)", () => {
  it("⭐ ลบ PII ออกจากลูกค้า แต่ธุรกรรมยังอยู่ครบ", async () => {
    await intakePartnerEvents("tagger", [purchase("p1"), intent("i1")]);
    const before = await db.collection(COLLECTIONS.customers).findOne({});
    expect(before!.status).toBe("active");

    const r = await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    expect(r.results[0]!.status).toBe("accepted");

    const after = await db.collection(COLLECTIONS.customers).findOne({ _id: before!._id } as never);
    expect(after!.status).toBe("erased");
    for (const f of ["phone", "email", "displayName", "nickname", "fullNameEn", "lineDisplayName", "facebook", "instagram", "pictureUrl"]) {
      expect(after![f], f).toBeNull();
    }
    expect(after!.erasedAt).toBeInstanceOf(Date);

    // ⭐ ธุรกรรมต้องอยู่ — เป็นเอกสารบัญชี
    expect(await db.collection("purchases").countDocuments()).toBe(1);
    expect(await db.collection("purchase_items").countDocuments()).toBe(1);
    const pur = await db.collection("purchases").findOne({});
    expect(pur!.amount).toBe(19710);
  });

  it("⭐ ไม่เหลือ PII ที่ไหนเลยในฐานหลัก", async () => {
    await intakePartnerEvents("tagger", [purchase("p1"), intent("i1")]);
    await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);

    for (const c of ["customers", "purchases", "purchase_items", "identities", "customer_profiles", "customer_intents"]) {
      const text = JSON.stringify(await db.collection(c).find({}).toArray());
      expect(text, c).not.toContain("0812345678");
      expect(text, c).not.toContain("+66812345678");
      expect(text, c).not.toContain("erase.me@example.com");
      expect(text, c).not.toContain("ทดสอบ ลบข้อมูล");
      expect(text, c).not.toContain(LINE_USER);
    }
  });

  it("identity ถูกตัด — ทักเข้ามาใหม่นับเป็นลูกค้าใหม่", async () => {
    await intakePartnerEvents("tagger", [purchase("p1")]);
    await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    expect(await db.collection(COLLECTIONS.identities).countDocuments()).toBe(0);

    await intakePartnerEvents("tagger", [{ ...purchase("p2"), payment: { ...purchase("p2").payment, externalPaymentId: "IN-ERASE-2" } }]);
    expect(await db.collection(COLLECTIONS.customers).countDocuments()).toBe(2);
  });

  it("ค่าประเมินความสนใจถูกลบ (เป็นการทำโปรไฟล์ ไม่ใช่เอกสารบัญชี)", async () => {
    await intakePartnerEvents("tagger", [purchase("p1"), intent("i1")]);
    expect(await db.collection(COLLECTIONS.customerIntents).countDocuments()).toBe(1);
    await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    expect(await db.collection(COLLECTIONS.customerIntents).countDocuments()).toBe(0);
  });

  it("⭐ ระบุตัวไม่ได้ → pending_identity ห้ามลบโดยเดา", async () => {
    await intakePartnerEvents("tagger", [purchase("p1")]);
    const r = await intakePartnerEvents("tagger", [erase("e1", { lineUserId: "Uไม่มีคนนี้" })]);
    expect(r.results[0]!.status).toBe("pending_identity");
    const cus = await db.collection(COLLECTIONS.customers).findOne({});
    expect(cus!.status).toBe("active"); // ของเดิมไม่ถูกแตะ
  });

  it("ไม่ส่ง subject มา → rejected", async () => {
    const r = await intakePartnerEvents("tagger", [{ eventId: "e-nosub", type: "erase", occurredAt: "2026-08-29T09:00:00+07:00", revision: 1 }]);
    expect(r.results[0]!.status).toBe("rejected");
    expect(r.results[0]!.reason).toBe("erase_requires_subject");
  });

  it("ยิงซ้ำไม่พัง และตั้งธงให้ชีต/AI mirror เขียนทับ", async () => {
    await intakePartnerEvents("tagger", [purchase("p1")]);
    await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    const r2 = await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    expect(r2.results[0]!.status).toBe("duplicate");
    const cus = await db.collection(COLLECTIONS.customers).findOne({});
    expect(cus!.sheetSync.dirty).toBe(true);
    expect(cus!.aiSync.dirty).toBe(true);
  });

  it("บันทึก audit log ไว้ แต่ไม่เก็บสำเนาของสิ่งที่เพิ่งลบ", async () => {
    await intakePartnerEvents("tagger", [purchase("p1")]);
    await intakePartnerEvents("tagger", [erase("e1", { lineUserId: LINE_USER })]);
    const logs = await db.collection(COLLECTIONS.auditLogs).find({ action: "customer.erased" }).toArray();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("0812345678");
    expect(JSON.stringify(logs)).not.toContain("erase.me@example.com");
  });
});
