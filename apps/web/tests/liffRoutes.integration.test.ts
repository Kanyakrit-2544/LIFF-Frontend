import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * route ใช้ cookies() ของ Next ซึ่งต้องมี request context
 * จำลองเป็น store ในหน่วยความจำเพื่อทดสอบ handler ตรง ๆ ได้
 */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

const { closeClient, COLLECTIONS, ensureIndexes, getDb, upsertSchema, createSession, SESSION_COOKIE } = await import("@line-crm/core");
const { POST: sessionPost } = await import("../app/api/liff/session/route");
const { GET: bootstrapGet } = await import("../app/api/liff/bootstrap/route");

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-s5-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const LINE_USER = `U${runId.replace(/[^a-z0-9]/gi, "").slice(0, 30)}`;
const CLIENT = process.env.LINE_LOGIN_CHANNEL_ID!;
let available = false;

const idTokenPayload = (over: Record<string, unknown> = {}) => ({
  iss: "https://access.line.me", sub: LINE_USER, aud: CLIENT,
  exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
  name: "LINE ชื่อเล่น", picture: "https://profile.line-scdn.net/test", ...over,
});

function stubLineVerify(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response));
}

const req = (body: unknown) => new Request("http://localhost/api/liff/session", { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม S5 integration test — ตั้ง RUN_MONGO_INTEGRATION=true\n");
    return;
  }
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  await upsertSchema({
    _id: "customer_onboarding@vtest", formId: "customer_onboarding", version: "vtest", status: "published",
    title: { th: "ทดสอบ" }, createdAt: new Date(), publishedAt: new Date(),
    sections: [{ id: "s", title: { th: "s" }, fields: [
      { id: "fullNameTh", type: "text", label: { th: "ชื่อ" }, validate: { required: true } },
      { id: "phone", type: "tel", label: { th: "เบอร์" }, validate: { required: true } },
    ] }],
  });
  available = true;
}, 30_000);

beforeEach(async () => { jar.clear(); vi.unstubAllGlobals(); if (available) await cleanup(); });
afterAll(async () => { if (available) { await cleanup(); await (await getDb()).collection(COLLECTIONS.formSchemas).deleteMany({ version: "vtest" }); } await closeClient(); });

async function cleanup() {
  const db = await getDb();
  const ids = await db.collection(COLLECTIONS.identities).find({ externalId: LINE_USER }).toArray();
  const cids = ids.map((i) => i.customerId);
  await Promise.all([
    cids.length ? db.collection(COLLECTIONS.customers).deleteMany({ _id: { $in: cids } }) : Promise.resolve(),
    db.collection(COLLECTIONS.identities).deleteMany({ externalId: LINE_USER }),
  ]);
}

describe.runIf(() => available)("POST /api/liff/session", () => {
  it("id_token ถูกต้อง → สร้างลูกค้า + ออก cookie", async () => {
    stubLineVerify(idTokenPayload());
    const res = await sessionPost(req({ idToken: "tok" }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.customer.customerId).toMatch(/^cus_/);
    expect(j.customer.isNew).toBe(true);
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
  });

  it("⭐ id_token ของ channel อื่น → 401", async () => {
    stubLineVerify(idTokenPayload({ aud: "9999999999" }));
    const res = await sessionPost(req({ idToken: "tok" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.details.reason).toBe("WRONG_AUDIENCE");
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("id_token หมดอายุ → 401 พร้อม reason ให้ frontend สั่ง login ใหม่", async () => {
    stubLineVerify(idTokenPayload({ exp: Math.floor(Date.now() / 1000) - 10 }));
    const res = await sessionPost(req({ idToken: "tok" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.details.reason).toBe("EXPIRED");
  });

  it("ไม่ส่ง idToken → 400", async () => {
    const res = await sessionPost(req({}));
    expect(res.status).toBe(400);
  });

  it("⭐ ห้ามเชื่อ userId/customerId จาก body — ใช้ sub จาก token เท่านั้น", async () => {
    stubLineVerify(idTokenPayload());
    const res = await sessionPost(req({ idToken: "tok", userId: "Uปลอม", customerId: "cus_คนอื่น" }));
    const j = await res.json();
    expect(j.customer.customerId).not.toBe("cus_คนอื่น");
    const db = await getDb();
    const idn = await db.collection(COLLECTIONS.identities).findOne({ customerId: j.customer.customerId });
    expect(idn?.externalId).toBe(LINE_USER);
  });

  it("เรียกซ้ำ → ลูกค้าคนเดิม ไม่สร้างใหม่", async () => {
    stubLineVerify(idTokenPayload());
    const a = await (await sessionPost(req({ idToken: "tok" }))).json();
    stubLineVerify(idTokenPayload());
    const b = await (await sessionPost(req({ idToken: "tok" }))).json();
    expect(b.customer.customerId).toBe(a.customer.customerId);
    expect(b.customer.isNew).toBe(false);
    expect(await (await getDb()).collection(COLLECTIONS.identities).countDocuments({ externalId: LINE_USER })).toBe(1);
  });

  it("⭐ คนที่แอดเพื่อนมาก่อน แล้วเปิด LIFF → ไม่เกิดลูกค้าซ้ำ", async () => {
    const db = await getDb();
    const { upsertFromLine } = await import("@line-crm/core");
    await upsertFromLine({
      eventId: `${runId}-follow`, channelId: "Ubotdestination", lineUserId: LINE_USER,
      eventType: "follow", occurredAt: new Date(), profile: { displayName: "จาก webhook" },
    });
    // นับเฉพาะลูกค้าที่ผูกกับ user ของเทสนี้ — นับทั้ง collection จะชนกับ test file อื่นที่รันขนาน
    const mine = async () => {
      const ids = await db.collection(COLLECTIONS.identities).find({ externalId: LINE_USER }).toArray();
      return new Set(ids.map((i) => i.customerId)).size;
    };
    const before = await mine();
    expect(before).toBe(1);

    stubLineVerify(idTokenPayload());
    const j = await (await sessionPost(req({ idToken: "tok" }))).json();

    expect(await mine()).toBe(before);
    expect(j.customer.isNew).toBe(false);
    expect(await db.collection(COLLECTIONS.identities).countDocuments({ externalId: LINE_USER })).toBe(1);
  });

  it("ชื่อจริงที่ลูกค้าเคยกรอกไม่ถูกทับด้วยชื่อ LINE", async () => {
    stubLineVerify(idTokenPayload());
    const j = await (await sessionPost(req({ idToken: "tok" }))).json();
    const db = await getDb();
    await db.collection(COLLECTIONS.customers).updateOne({ _id: j.customer.customerId }, { $set: { displayName: "สมชาย ใจดี" } });

    stubLineVerify(idTokenPayload());
    await sessionPost(req({ idToken: "tok" }));
    const doc = await db.collection(COLLECTIONS.customers).findOne({ _id: j.customer.customerId });
    expect(doc?.displayName).toBe("สมชาย ใจดี");
    expect(doc?.lineDisplayName).toBe("LINE ชื่อเล่น");
  });

  it("email จาก id_token ส่งกลับไปให้ prefill", async () => {
    stubLineVerify(idTokenPayload({ email: "somchai@gmail.com" }));
    const j = await (await sessionPost(req({ idToken: "tok" }))).json();
    expect(j.lineEmail).toBe("somchai@gmail.com");
  });
});

describe.runIf(() => available)("GET /api/liff/bootstrap", () => {
  it("ไม่มี cookie → 401", async () => {
    expect((await bootstrapGet()).status).toBe(401);
  });

  it("cookie ปลอม → 401", async () => {
    jar.set(SESSION_COOKIE, "aaa.bbb.ccc");
    expect((await bootstrapGet()).status).toBe(401);
  });

  it("session หมดอายุ → 401", async () => {
    jar.set(SESSION_COOKIE, createSession({ customerId: "cus_x", lineUserId: LINE_USER, channelId: CLIENT }, -1));
    const res = await bootstrapGet();
    expect(res.status).toBe(401);
    expect((await res.json()).error.details.reason).toBe("EXPIRED");
  });

  it("session ถูกต้อง → คืน profile + formSchema + prefill", async () => {
    stubLineVerify(idTokenPayload());
    await sessionPost(req({ idToken: "tok" }));
    const res = await bootstrapGet();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.profile.customerId).toMatch(/^cus_/);
    expect(j.formSchema.formId).toBe("customer_onboarding");
    expect(j.formSchema.sections.length).toBeGreaterThan(0);
    expect(j.prefill).toHaveProperty("fullNameTh");
    expect(j.consentRequired).toBe(true);
  });

  it("prefill เติมชื่อจาก LINE ให้อัตโนมัติ", async () => {
    stubLineVerify(idTokenPayload());
    await sessionPost(req({ idToken: "tok" }));
    const j = await (await bootstrapGet()).json();
    expect(j.prefill.fullNameTh).toBe("LINE ชื่อเล่น");
  });

  it("⭐ ไม่คืนข้อมูลดิบที่เป็นความลับ (phoneEnc / phoneHash / lineUserId)", async () => {
    stubLineVerify(idTokenPayload());
    await sessionPost(req({ idToken: "tok" }));
    const text = await (await bootstrapGet()).text();
    for (const leak of ["phoneEnc", "phoneHash", "emailHash", '"enc"', LINE_USER]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});
