import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { closeClient, getDb, COLLECTIONS, __resetEnvCache } from "@line-crm/core";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const d = runIntegration ? describe : describe.skip;

const APP_SECRET = "fb-app-secret-for-test";
const VERIFY_TOKEN = "fb-verify-token-for-test";
const PAGE_ID = "PAGE_TEST_1";

function withFacebookEnv(): void {
  process.env.FACEBOOK_APP_SECRET = APP_SECRET;
  process.env.FACEBOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.FACEBOOK_PAGE_ID = PAGE_ID;
  __resetEnvCache();
}
function withoutFacebookEnv(): void {
  delete process.env.FACEBOOK_APP_SECRET;
  delete process.env.FACEBOOK_VERIFY_TOKEN;
  delete process.env.FACEBOOK_PAGE_ID;
  __resetEnvCache();
}

const sign = (body: string, secret = APP_SECRET) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

function leadBody(leadgenId: string, pageId = PAGE_ID): string {
  return JSON.stringify({
    object: "page",
    entry: [{ id: pageId, time: 1787900000, changes: [{ field: "leadgen", value: {
      leadgen_id: leadgenId, page_id: pageId, form_id: "F1", ad_id: "AD1", created_time: 1787900000,
    } }] }],
  });
}

async function route() {
  return await import("../app/api/webhook/facebook/route");
}

const post = async (body: string, signature: string | null) => {
  const { POST } = await route();
  return POST(new Request("https://x.test/api/webhook/facebook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
  }));
};

d("POST /api/webhook/facebook", () => {
  beforeEach(async () => {
    withFacebookEnv();
    const db = await getDb();
    await db.collection(COLLECTIONS.inboundEvents).deleteMany({ provider: "facebook" });
  });
  afterAll(async () => {
    withoutFacebookEnv();
    await closeClient();
  });

  it("⭐ ยังไม่ตั้ง env → 404 เหมือนไม่มี route นี้ (D32)", async () => {
    withoutFacebookEnv();
    const res = await post(leadBody("L404"), null);
    expect(res.status).toBe(404);
  });

  it("ลายเซ็นผิด/ไม่มี → 401 และไม่แตะฐานข้อมูล", async () => {
    const body = leadBody("L401");
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(body, "wrong-secret"))).status).toBe(401);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.inboundEvents).countDocuments({ provider: "facebook" })).toBe(0);
  });

  it("ลายเซ็นถูก → 200 และเข้าคิว", async () => {
    const body = leadBody("L200");
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 1 });
  });

  it("⭐ ยิงซ้ำ 5 ครั้งเหลือ event เดียว (Meta ไม่มี timestamp ให้กัน replay)", async () => {
    const body = leadBody("L-dup");
    for (let i = 0; i < 5; i++) await post(body, sign(body));
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.inboundEvents).countDocuments({ eventId: "L-dup" })).toBe(1);
  });

  it("⭐ สิ่งที่เก็บลงคิวต้องไม่มี PII", async () => {
    const body = leadBody("L-pii");
    await post(body, sign(body));
    const db = await getDb();
    const doc = await db.collection(COLLECTIONS.inboundEvents).findOne({ eventId: "L-pii" });
    expect(JSON.stringify(doc!.raw)).not.toMatch(/@|[ก-๙]|0[689]\d{8}/);
    expect(doc!.provider).toBe("facebook");
    expect(doc!.channelId).toBe(PAGE_ID);
  });

  it("event ของเพจอื่นถูกเมิน ไม่เข้าคิว", async () => {
    const body = leadBody("L-other", "PAGE_SOMEONE_ELSE");
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    const db = await getDb();
    expect(await db.collection(COLLECTIONS.inboundEvents).countDocuments({ eventId: "L-other" })).toBe(0);
  });

  it("body ว่างตอน Meta กดทดสอบ → 200 ไม่พัง", async () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    expect((await post(body, sign(body))).status).toBe(200);
  });
});

d("GET /api/webhook/facebook (ตั้ง webhook)", () => {
  beforeEach(() => withFacebookEnv());
  afterAll(() => withoutFacebookEnv());

  const get = async (qs: string) => {
    const { GET } = await route();
    return GET(new Request(`https://x.test/api/webhook/facebook?${qs}`));
  };

  it("verify_token ถูก → คืน challenge เป็น text ล้วน", async () => {
    const res = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("12345");
  });

  it("verify_token ผิด → 403 และไม่คืน challenge", async () => {
    const res = await get("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("12345");
  });

  it("ยังไม่ตั้ง env → 404", async () => {
    withoutFacebookEnv();
    expect((await get("hub.mode=subscribe")).status).toBe(404);
  });
});
