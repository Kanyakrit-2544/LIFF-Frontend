import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

const core = await import("@line-crm/core");
const { closeClient, COLLECTIONS, ensureIndexes, getDb, upsertSchema, createSession, SESSION_COOKIE, newCustomerId } = core;
const { POST: submit } = await import("../app/api/liff/customer/profile/route");

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `s7-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const FORM_ID = "customer_onboarding";
const VER = `t-${runId}`;
let available = false;
let customerId = "";

const req = (body: unknown, key = `k-${runId}-${Math.random()}`) =>
  new Request("http://localhost/api/liff/customer/profile", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ formId: FORM_ID, formVersion: VER, idempotencyKey: key, ...(body as object) }),
  });

const answers = (over: Record<string, unknown> = {}) => ({
  answers: { fullNameTh: "สมชาย ใจดี", phone: "0812345678", consentDataProcessing: true, ...over },
});

async function makeCustomer(): Promise<string> {
  const id = newCustomerId();
  await (await getDb()).collection(COLLECTIONS.customers).insertOne({
    _id: id, status: "active", mergedInto: null, displayName: null, nickname: null, fullNameEn: null,
    birthYear: null, lineDisplayName: `LINE ${runId}`, pictureUrl: null, facebook: null, instagram: null,
    phone: null, email: null, customerStatus: "lead", tags: [],
    source: { channel: "line", campaign: null }, sources: ["line"], consent: null, profileRef: null,
    sheetSync: { dirty: false, rowKey: id, syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 }, firstInteractionAt: new Date(), firstMessageAt: null,
    lastInteractionAt: new Date(), createdAt: new Date(), updatedAt: new Date(), schemaVersion: 1,
  } as never);
  return id;
}

beforeAll(async () => {
  if (!runIntegration) { console.warn("\n⚠️  ข้าม S7 test — ตั้ง RUN_MONGO_INTEGRATION=true\n"); return; }
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  await upsertSchema({
    _id: `${FORM_ID}@${VER}`, formId: FORM_ID, version: VER, status: "published",
    title: { th: "ทดสอบ" }, createdAt: new Date(), publishedAt: new Date(),
    sections: [{ id: "s", title: { th: "s" }, fields: [
      { id: "fullNameTh", type: "text", label: { th: "ชื่อ" }, validate: { required: true } },
      { id: "nickname", type: "text", label: { th: "ชื่อเล่น" } },
      { id: "phone", type: "tel", label: { th: "เบอร์" }, validate: { required: true } },
      { id: "email", type: "email", label: { th: "อีเมล" } },
      { id: "consentDataProcessing", type: "consent", label: { th: "ยินยอม" }, validate: { required: true } },
      { id: "consentMarketing", type: "consent", label: { th: "ข่าวสาร" } },
    ] }],
  });
  available = true;
}, 30_000);

beforeEach(async () => {
  if (!available) return;
  jar.clear();
  await cleanup();
  customerId = await makeCustomer();
  jar.set(SESSION_COOKIE, createSession({ customerId, lineUserId: `U${runId}`, channelId: "2011263761" }));
});

afterAll(async () => {
  if (available) {
    await cleanup();
    await (await getDb()).collection(COLLECTIONS.formSchemas).deleteMany({ version: VER });
  }
  await closeClient();
});

async function cleanup() {
  const db = await getDb();
  const cs = await db.collection(COLLECTIONS.customers).find({ lineDisplayName: `LINE ${runId}` }).toArray();
  const ids = cs.map((c) => c._id as unknown as string);
  await Promise.all([
    db.collection(COLLECTIONS.customers).deleteMany({ lineDisplayName: `LINE ${runId}` }),
    ids.length ? db.collection(COLLECTIONS.customerProfiles).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
    ids.length ? db.collection(COLLECTIONS.interactions).deleteMany({ customerId: { $in: ids } }) : Promise.resolve(),
    db.collection(COLLECTIONS.auditLogs).deleteMany({ action: { $in: ["customer.merge", "customer.merge_pending"] } }),
    db.collection("rate_limits").deleteMany({}),
  ]);
}

describe.runIf(runIntegration)("POST /api/liff/customer/profile", () => {
  it("ไม่มี session → 401", async () => {
    jar.clear();
    expect((await submit(req(answers()))).status).toBe(401);
  });

  it("ส่งครบ → 200, revision 1, เขียนลง customers", async () => {
    const res = await submit(req(answers()));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.revision).toBe(1);

    const c = await (await getDb()).collection(COLLECTIONS.customers).findOne({ _id: customerId } as never);
    expect(c?.displayName).toBe("สมชาย ใจดี");
    expect(c?.phone).toBe("+66812345678");
    expect(c?.sheetSync.dirty).toBe(true);
    expect(c?.aiSync.dirty).toBe(true);
    expect(c?.consent?.dataProcessing).toBe(true);
    expect(c?.counters.formSubmits).toBe(1);
  });

  it("⭐ S9 เก็บเบอร์เป็น plaintext normalized ใน DB หลัก และไม่มี field encrypt/hash เก่า", async () => {
    await submit(req(answers()));
    const c = await (await getDb()).collection(COLLECTIONS.customers).findOne({ _id: customerId } as never);
    expect(c?.phone).toBe("+66812345678");
    expect(c).not.toHaveProperty("phoneHash");
    expect(c).not.toHaveProperty("emailHash");
    expect(JSON.stringify(c)).not.toContain('"enc"');
  });

  it("ขาด required → 400 พร้อมชื่อ field", async () => {
    const res = await submit(req(answers({ fullNameTh: "" })));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.details.some((d: { field: string }) => d.field === "fullNameTh")).toBe(true);
  });

  it("ไม่ติ๊กยินยอม → 400", async () => {
    expect((await submit(req(answers({ consentDataProcessing: false })))).status).toBe(400);
  });

  it("เบอร์ผิดรูปแบบ → 400", async () => {
    expect((await submit(req(answers({ phone: "123" })))).status).toBe(400);
  });

  it("⭐ field แปลกปลอมถูกปฏิเสธ (mass assignment)", async () => {
    const res = await submit(req(answers({ customerStatus: "vip", isAdmin: true })));
    expect(res.status).toBe(400);
    const c = await (await getDb()).collection(COLLECTIONS.customers).findOne({ _id: customerId } as never);
    expect(c?.customerStatus).toBe("lead");
  });

  it("⭐ customerId ใน body ไม่มีผล — ใช้จาก session", async () => {
    const other = await makeCustomer();
    await submit(req({ ...answers(), customerId: other }));
    const mine = await (await getDb()).collection(COLLECTIONS.customers).findOne({ _id: customerId } as never);
    const theirs = await (await getDb()).collection(COLLECTIONS.customers).findOne({ _id: other } as never);
    expect(mine?.displayName).toBe("สมชาย ใจดี");
    expect(theirs?.displayName).toBeNull();
  });

  it("⭐ กดส่งรัว ๆ ด้วย key เดิม → มี profile เดียว", async () => {
    const key = `dup-${runId}`;
    const [a, b, c] = await Promise.all([submit(req(answers(), key)), submit(req(answers(), key)), submit(req(answers(), key))]);
    expect([a.status, b.status, c.status].every((s) => s === 200)).toBe(true);
    expect(await (await getDb()).collection(COLLECTIONS.customerProfiles).countDocuments({ customerId })).toBe(1);
  });

  it("ส่งครั้งที่สอง (คนละ key) → revision 2, ของเดิมยังอยู่", async () => {
    await submit(req(answers()));
    const j = await (await submit(req(answers({ nickname: "ชาย" })))).json();
    expect(j.revision).toBe(2);
    expect(await (await getDb()).collection(COLLECTIONS.customerProfiles).countDocuments({ customerId })).toBe(2);
  });

  it("formVersion ที่ไม่มีอยู่ → 404", async () => {
    const res = await submit(new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ formId: FORM_ID, formVersion: "ไม่มีจริง", idempotencyKey: "k404", ...answers() }),
    }));
    expect(res.status).toBe(404);
  });

  it("⭐ เบอร์ตรงกับลูกค้าอีกคน → ไม่ merge อัตโนมัติ แต่ตั้งธงให้คนตรวจ", async () => {
    // เบอร์ที่พิมพ์ในฟอร์มคือ "การอ้าง" ที่ยังไม่ได้ตรวจสอบ
    // ถ้า merge เลย = ใครพิมพ์เบอร์คนอื่นก็ยึดข้อมูลเขาได้
    const db = await getDb();
    const other = await makeCustomer();
    await db.collection(COLLECTIONS.customers).updateOne({ _id: other } as never, {
      $set: { phone: "+66812345678", displayName: "ลูกค้าเก่า", nickname: "เก่า",
              createdAt: new Date(Date.now() - 86400000) },
    });

    const j = await (await submit(req(answers()))).json();
    expect(j.merged).toBe(false);
    expect(j.customerId).toBe(customerId);

    // ทั้งสองบัญชียัง active ไม่มีใครถูกกลืน
    const mine = await db.collection(COLLECTIONS.customers).findOne({ _id: customerId } as never);
    const theirs = await db.collection(COLLECTIONS.customers).findOne({ _id: other } as never);
    expect(mine?.status).toBe("active");
    expect(theirs?.status).toBe("active");
    expect(theirs?.mergedInto).toBeNull();

    // ข้อมูลของอีกฝ่ายต้องไม่ถูกดูดเข้ามา
    expect(mine?.nickname).not.toBe("เก่า");

    // ตั้งธงไว้ให้เจ้าหน้าที่ตัดสิน + มี audit
    expect(mine?.pendingMerge?.candidateId).toBe(other);
    expect(mine?.pendingMerge?.reason).toBe("phone_match");
    expect(await db.collection(COLLECTIONS.auditLogs).countDocuments({ action: "customer.merge_pending" })).toBeGreaterThan(0);
  });

  it("⭐ ส่งถี่เกิน 5 ครั้ง/นาที → 429", async () => {
    const res = await Promise.all(Array.from({ length: 9 }, (_, i) => submit(req(answers(), `rl-${runId}-${i}`))));
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });

  it("clientMeta ขนาดใหญ่ถูกจำกัดก่อนเก็บ", async () => {
    await submit(req({ ...answers(), clientMeta: { junk: "x".repeat(500_000) } }));
    const pf = await (await getDb()).collection(COLLECTIONS.customerProfiles).findOne({ customerId });
    expect(JSON.stringify(pf?.clientMeta ?? {}).length).toBeLessThan(3000);
  });

  it("สร้าง interaction form_submit", async () => {
    await submit(req(answers()));
    const n = await (await getDb()).collection(COLLECTIONS.interactions).countDocuments({ customerId, type: "form_submit" });
    expect(n).toBe(1);
  });

  it("normalize เบอร์เป็น E.164 และอีเมลตัวพิมพ์เล็ก", async () => {
    await submit(req(answers({ phone: "081-234-5678", email: " A@B.COM " })));
    const prof = await (await getDb()).collection(COLLECTIONS.customerProfiles).findOne({ customerId });
    expect(prof?.answers.phone).toBe("+66812345678");
    expect(prof?.answers.email).toBe("a@b.com");
  });
});
