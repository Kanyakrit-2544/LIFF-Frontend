import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, COLLECTIONS, ensureIndexes, getDb, newCustomerId, signInternal, type CustomerDoc } from "@line-crm/core";
import { POST as pendingPost } from "../app/api/internal/ai-mirror/pending/route";
import { POST as ackPost } from "../app/api/internal/ai-mirror/ack/route";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `vitest-s9-web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let available = false;

beforeAll(async () => {
  if (!runIntegration) {
    console.warn("\n⚠️  ข้าม S9 AI mirror route test — ตั้ง RUN_MONGO_INTEGRATION=true เพื่อยิง MongoDB จริง\n");
    return;
  }
  const db = await getDb();
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  available = true;
}, 30_000);

beforeEach(async () => {
  if (available) await cleanup();
});

afterAll(async () => {
  if (available) await cleanup();
  await closeClient();
});

async function cleanup() {
  const db = await getDb();
  await db.collection(COLLECTIONS.customers).deleteMany({ lineDisplayName: { $regex: `^${runId}` } });
}

function signed(body: Record<string, unknown>, ts = Math.floor(Date.now() / 1000), secret = process.env.INTERNAL_HMAC_SECRET!) {
  const raw = JSON.stringify(body);
  return new Request("http://test.local/api/internal/ai-mirror", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signInternal(raw, ts, secret),
      "x-timestamp": String(ts),
    },
    body: raw,
  });
}

function unsigned(body: Record<string, unknown>) {
  return new Request("http://test.local/api/internal/ai-mirror", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { status: res.status, json: await res.json() };
}

async function insertCustomer() {
  const id = newCustomerId();
  const now = new Date("2026-08-27T04:00:00Z");
  await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).insertOne({
    _id: id,
    status: "active",
    mergedInto: null,
    displayName: "สมชาย ใจดี",
    nickname: null,
    fullNameEn: null,
    birthYear: 2535,
    lineDisplayName: `${runId}-${id}`,
    pictureUrl: null,
    facebook: null,
    instagram: null,
    phone: "+66812345678",
    email: "somchai@gmail.com",
    customerStatus: "lead",
    tags: ["line-follower"],
    source: { channel: "line", campaign: null },
    sources: ["line"],
    consent: { dataProcessing: true, marketing: true, version: "v1", grantedAt: now, ip: "203.0.113.10", userAgent: "Mozilla test" },
    profileRef: { revision: 1, formId: "customer_onboarding", formVersion: "v1", updatedAt: now },
    pendingMerge: null,
    sheetSync: { dirty: false, rowKey: id, syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now,
    firstMessageAt: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  return id;
}

describe.runIf(runIntegration)("S9 internal AI mirror routes", () => {
  it("/ai-mirror/pending ไม่มี HMAC → 401", async () => {
    const res = await read(await pendingPost(unsigned({ limit: 10 })));
    expect(res.status).toBe(401);
  });

  it("/ai-mirror/pending timestamp เก่า → 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const res = await read(await pendingPost(signed({ limit: 10 }, old)));
    expect(res.status).toBe(401);
  });

  it("pending คืนเฉพาะข้อมูล scrubbed ไม่ส่ง PII ดิบให้ n8n", async () => {
    const id = await insertCustomer();
    const res = await read(await pendingPost(signed({ limit: 10 })));
    expect(res.status).toBe(200);
    expect(res.json.claimed).toBe(1);
    expect(res.json.rows[0].customerId).toBe(id);
    const text = JSON.stringify(res.json);
    expect(text).toContain("08x-xxx-5678");
    for (const raw of ["+66812345678", "somchai@gmail.com", "สมชาย", "203.0.113.10", "Mozilla"]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  it("/ai-mirror/ack ok เคลียร์ dirty", async () => {
    const id = await insertCustomer();
    const pending = await read(await pendingPost(signed({ limit: 10 })));
    const res = await read(await ackPost(signed({ claimId: pending.json.claimId, results: [{ customerId: id, status: "ok" }] })));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(1);
    expect(res.json.remaining).toBe(0);
    const doc = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: id });
    expect(doc?.aiSync.dirty).toBe(false);
  });
});
