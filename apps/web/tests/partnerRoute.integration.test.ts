import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeClient,
  COLLECTIONS,
  ensureIndexes,
  getDb,
  signInternal,
  type PurchaseDoc,
} from "@line-crm/core";
import { POST } from "../app/api/partner/intake/route";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `web_m35_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const partnerId = "tagger";
const secret = "test-partner-hmac-secret-must-be-at-least-32-chars";
let available = false;

function purchase(id: string) {
  return {
    eventId: `${runId}_${id}`, type: "purchase", occurredAt: "2026-08-28T10:00:00+07:00", revision: 1,
    subject: { fullName: "ผู้ซื้อทดสอบ" },
    payment: {
      externalPaymentId: null, amount: 999, currency: "THB", paidAt: "2026-08-28", saleRep: null,
      lines: [{ courseLabel: "Inner", kind: "enrolled" }],
    },
  };
}

function request(body: unknown, options: { timestamp?: number; signature?: string | null; partner?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = options.signature === undefined ? signInternal(raw, timestamp, secret) : options.signature;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-partner-id": options.partner ?? partnerId,
    "x-timestamp": String(timestamp),
  };
  if (signature) headers["x-signature"] = signature;
  return new Request("http://test.local/api/partner/intake", { method: "POST", headers, body: raw });
}

async function cleanup() {
  const db = await getDb();
  const purchases = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
    .find({ partnerId, sourceEventId: { $regex: `^${runId}` } }, { projection: { _id: 1 } }).toArray();
  await Promise.all([
    db.collection(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: { $in: purchases.map((row) => row._id) } }),
    db.collection(COLLECTIONS.purchases).deleteMany({ partnerId, sourceEventId: { $regex: `^${runId}` } }),
    db.collection(COLLECTIONS.partnerEvents).deleteMany({ partnerId, eventId: { $regex: `^${runId}` } }),
    db.collection(COLLECTIONS.partnerQuarantine).deleteMany({ partnerId, eventId: { $regex: `^${runId}` } }),
    db.collection<{ _id: string }>("rate_limits").deleteMany({ _id: { $regex: "^partner:intake:tagger" } }),
  ]);
}

beforeAll(async () => {
  if (!runIntegration) return;
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

describe.runIf(runIntegration)("POST /api/partner/intake", () => {
  it("signature หาย ผิด หรือ timestamp เก่าเกิน 300 วินาทีตอบ 401", async () => {
    expect((await POST(request({ events: [purchase("unsigned")] }, { signature: null }))).status).toBe(401);
    expect((await POST(request({ events: [purchase("bad-signature")] }, { signature: "sha256=bad" }))).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 301;
    expect((await POST(request({ events: [purchase("old")] }, { timestamp: old }))).status).toBe(401);
  });

  it("partner ที่ไม่มี secret ตอบ 401", async () => {
    expect((await POST(request({ events: [purchase("unknown-partner")] }, { partner: "unknown" }))).status).toBe(401);
  });

  it("body เกิน 1 MB หรือเกิน 100 events ตอบ 400", async () => {
    expect((await POST(request({ events: [purchase("large")], padding: "x".repeat(1024 * 1024) }))).status).toBe(400);
    expect((await POST(request({ events: Array.from({ length: 101 }, (_, index) => purchase(`too-many-${index}`)) }))).status).toBe(400);
  });

  it("คำขอที่เซ็นถูกบันทึกและยิงซ้ำไม่สร้าง purchase เพิ่ม", async () => {
    const body = { events: [purchase("signed")] };
    const first = await POST(request(body));
    const second = await POST(request(body));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, summary: { pendingIdentity: 1 } });
    expect(await second.json()).toMatchObject({ ok: true, summary: { duplicate: 1 } });
    expect(await (await getDb()).collection(COLLECTIONS.purchases).countDocuments({ partnerId, sourceEventId: `${runId}_signed` })).toBe(1);
  });
});
